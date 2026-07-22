/**
 * docs/05 §6.3.3 / F-005 / R-05 — Editor エージェント (全章統合校閲 + AI 開示文巻末挿入)。
 *
 * フロー (Writer outline/chapter と同パターン):
 *  1. `loadActivePrompt('editor', genre)` で active プロンプトを取得
 *  2. プレースホルダ ({theme_title}/{theme_subtitle}/{theme_hook}/{target_reader}/
 *     {draft_chapters}/{ai_disclosure_text}/{feedback}/{genre}/{chapter_count}) を差込
 *     - draft_chapters は全章を JSON 配列として埋め込む
 *  3. `createAgentClient('editor', genre, ctx)` で LLMClient (withTokenLogging ラップ済) 取得
 *  4. `client.complete({ system, user, maxOutputTokens: 32768 })` を 1 回呼ぶ
 *     - 全章統合校閲は output が大きい (~50,000 字 + JSON 構造) ので 32K に拡張
 *  5. **F-005 受入基準** の自動検証:
 *     - 出力 chapters の章数が入力と一致
 *     - 出力 chapters の index が入力と一致 (順序維持)
 *     - 各章 body_md 500 字以上 (zod min(500) で強制)
 *  6. **R-05 安全装置**: 最終章 body_md 末尾に aiDisclosureText が含まれることを確認
 *     - 未含なら呼出側で**強制挿入** + `ai_disclosure_appended: true` で返却
 *     - LLM が忘れても KDP コンテンツガイドライン違反を防ぐ
 *
 * エラー方針 (Writer chapter と同型):
 *  - JSON 抽出/parse 失敗 → `AgentError('editor.invalid_output', { rawText, cause })`
 *  - zod 検証失敗          → `AgentError('editor.invalid_output', { issues, rawText })`
 *  - 章数不一致 / index 不一致 → `AgentError('editor.chapters_mismatch', { details })`
 *  - LLM 呼出失敗 (ProviderError 等) はそのまま透過 (上位 worker の retry 対象)
 *
 * DI: `deps?.createAgentClient` / `deps?.loadActivePrompt` でテスト差し替え可能。
 *
 * T-03-01 / T-04-01/02 教訓:
 *  - jobId は graphile-worker.jobs.id 専用 — UI 直接呼出時は undefined → null forward
 *  - schema は DB `chapters` 列 (heading / body_md) + docs/05 §6.3.3 と完全整合 (Hard Rule #3)
 *  - AgentSdkClient は responseSchema 非対応 — 自由テキスト → JSON 抽出 → zod の三段
 */
import { genreLabel } from '@a2p/contracts/agents';
import { AgentError } from '@a2p/contracts/errors';
import type { LLMClient } from '@a2p/contracts/agents';
import {
  EditorInputSchema,
  EditorChapterOutputSchema,
  type EditorChapterInput,
  type EditorChapterOutput,
  type EditorInput,
  type EditorOutput,
} from '@a2p/contracts/agents/editor';
import type { RevisionFeedbackItem } from '@a2p/contracts/agents/writer';

import { createAgentClient as defaultCreateAgentClient } from '../lib/llm-client-factory.js';
import {
  fillPlaceholders,
  loadActivePrompt as defaultLoadActivePrompt,
  type PromptLoaderDeps,
} from '../lib/prompt-loader.js';
import type {
  LoggingContext,
  WithTokenLoggingDeps,
} from '../lib/with-token-logging.js';
import type { LoadModelAssignmentDeps } from '../lib/load-model-assignment.js';

/**
 * Editor LLM 呼出の既定 max tokens。全章 (~50,000 字) を校閲して返すため
 * 16384 では足りない。日本語 1.5 tok/char 換算で 50,000 字 ~= 75,000 tok だが、
 * 各章を要約せず全文返す前提で 32,768 を確保 (JSON 構造分の余裕含む)。
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 32768;

export interface EditBookDeps {
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  createAgentClient?: typeof defaultCreateAgentClient;
  /** prompt-loader 内 Prisma 差し替え用 deps。 */
  promptLoaderDeps?: PromptLoaderDeps;
  /** factory 内 ModelAssignment / withTokenLogging 差し替え用 deps。 */
  loadAssignmentDeps?: LoadModelAssignmentDeps;
  withTokenLoggingDeps?: WithTokenLoggingDeps;
  /** factory 内 getApiKey 差し替え (テストで env / DB を引かない)。 */
  getApiKey?: (provider: string) => Promise<string>;
}

/**
 * F-005 受入基準: 全章を統合校閲し、AI 開示文を巻末挿入する。
 *
 * @throws AgentError JSON 抽出/parse 失敗 / zod 検証失敗 / 章数/index 不一致
 * @throws ProviderError LLM API 失敗 (透過、上位 worker でリトライ)
 * @throws ConfigError   active プロンプト不在 / API キー不在
 */
export async function editBook(
  input: EditorInput,
  deps: EditBookDeps = {},
): Promise<EditorOutput> {
  // 1. 入力 zod 検証 (呼出側 SA で済んでいる想定だが、二重防衛)
  const parsedInput = EditorInputSchema.parse(input);

  const loadPrompt = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const makeClient = deps.createAgentClient ?? defaultCreateAgentClient;

  // 2. active プロンプト取得 + プレースホルダ差込
  //    draft_chapters は全章を JSON 配列文字列として埋め込む (LLM が章単位で校閲できるよう)
  const prompt = await loadPrompt(
    'editor',
    parsedInput.genre,
    deps.promptLoaderDeps,
  );
  // 3. LLMClient (withTokenLogging ラップ済) 取得
  //    jobId は input から forward — 未指定なら ctx に key を含めず token_usage.job_id=null
  //    bookId は Editor 起動時点で確定済み → ctx.bookId に必ず詰める
  const ctx: LoggingContext = {
    role: 'editor',
    bookId: parsedInput.bookId,
  };
  if (parsedInput.jobId !== undefined) {
    ctx.jobId = parsedInput.jobId;
  }

  const factoryDeps: Parameters<typeof makeClient>[3] = {};
  if (deps.loadAssignmentDeps) factoryDeps.loadAssignmentDeps = deps.loadAssignmentDeps;
  if (deps.withTokenLoggingDeps) factoryDeps.withTokenLoggingDeps = deps.withTokenLoggingDeps;
  if (deps.getApiKey) factoryDeps.getApiKey = deps.getApiKey;

  const client: LLMClient = await makeClient(
    'editor',
    parsedInput.genre,
    ctx,
    factoryDeps,
  );

  // 4. LLM 呼出 — **章ごとに分割**して校閲する。
  //    全章を 1 回で返す設計だと出力 (~50,000 字 + JSON) が maxOutputTokens を超えて
  //    truncation し JSON parse に失敗する (8 章規模で editor.invalid_output が再現)。
  //    章単位で呼び出し、結果を入力順で結合する。AI 開示文は最終章にのみ付与する
  //    (各章末への重複挿入を防ぐため、非最終章では ai_disclosure_text を空で渡す)。
  const editedChapters: EditorChapterOutput[] = [];
  for (let ci = 0; ci < parsedInput.chapters.length; ci++) {
    const chapter = parsedInput.chapters[ci]!;
    const isLast = ci === parsedInput.chapters.length - 1;
    const disclosureForChunk = isLast ? parsedInput.aiDisclosureText : '';
    const chunkInput: EditorInput = {
      ...parsedInput,
      chapters: [chapter],
      aiDisclosureText: disclosureForChunk,
    };

    const systemPrompt = fillPlaceholders(prompt.template, {
      theme_title: parsedInput.themeContext.title,
      theme_subtitle: parsedInput.themeContext.subtitle ?? '',
      theme_hook: parsedInput.themeContext.hook,
      target_reader: parsedInput.themeContext.target_reader,
      chapter_count: 1,
      draft_chapters: JSON.stringify(chunkInput.chapters),
      ai_disclosure_text: disclosureForChunk,
      feedback: formatFeedback(parsedInput.feedback),
      genre: genreLabel(parsedInput.genre) ?? 'general',
    });

    const completion = await client.complete({
      role: 'editor',
      genre: parsedInput.genre,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildUserMessage(chunkInput) },
      ],
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    });

    const rawText = completion.text;
    if (typeof rawText !== 'string' || rawText.trim().length === 0) {
      throw new AgentError('editor.invalid_output: empty response', {
        details: { rawText: String(rawText), chapterIndex: chapter.index },
      });
    }

    // 5. JSON 抽出 — schema-aware predicate で `chapters` 配列を持つブロックを優先選択
    const parsedJson = extractJson(rawText, hasEditorShape);
    if (parsedJson === undefined) {
      throw new AgentError('editor.invalid_output: failed to parse JSON', {
        details: { rawText, chapterIndex: chapter.index },
      });
    }

    // 6. 欠落フィールド救済 → **章要素**を zod 検証。
    //    出力ラッパ (EditorOutputSchema) は chapters.min(7) を要求するため、
    //    章分割では要素スキーマ (EditorChapterOutputSchema) で 1 章ずつ検証する。
    const normalized = normalizePartialOutput(parsedJson, chunkInput);
    const chaptersRaw = (normalized as { chapters?: unknown }).chapters;
    const firstRaw = Array.isArray(chaptersRaw) ? chaptersRaw[0] : undefined;
    if (firstRaw === undefined) {
      throw new AgentError('editor.invalid_output: missing chapter in output', {
        details: { rawText, chapterIndex: chapter.index },
      });
    }
    const validated = EditorChapterOutputSchema.safeParse(firstRaw);
    if (!validated.success) {
      throw new AgentError('editor.invalid_output: schema validation failed', {
        details: { rawText, issues: validated.error.issues, chapterIndex: chapter.index },
        cause: validated.error,
      });
    }

    // index は入力章のものへ正規化して順序を保証する。
    const editedChapter = validated.data;
    editedChapters.push(
      editedChapter.index === chapter.index
        ? editedChapter
        : { ...editedChapter, index: chapter.index },
    );
  }

  // 7. 章数不一致検証 (F-005 受入基準: 全章校閲、抜け落ち禁止)
  if (editedChapters.length !== parsedInput.chapters.length) {
    throw new AgentError('editor.chapters_mismatch: count differs from input', {
      details: {
        input_count: parsedInput.chapters.length,
        output_count: editedChapters.length,
      },
    });
  }

  // 7b. **全体整合パス (第2段校閲)**。
  //    章分割校閲 (第1段) は各章が他章を知らないため、「次章は〇〇」「第N章で詳述」
  //    といった章間参照や、第1章の章立てロードマップが実体とズレる (Quality Judge 指摘)。
  //    全章の確定見出し一覧 (TOC) を各章に渡し、**事実誤りの参照だけ**を補正する
  //    軽量パスを通す。本文の内容・構成・文体は変更しない。
  const toc = editedChapters.map((c) => ({ index: c.index, heading: c.heading }));
  const reconciled = await runConsistencyPass(editedChapters, toc, parsedInput, client);

  // 8. 章末尾の AI 生成開示文を全章から除去する。
  //    章分割校閲では LLM が各章末に開示文を付けがちだが、開示は**巻末 (最終章)
  //    に 1 回だけ**で足りる (KDP は書籍単位の開示で十分)。
  const aiText = parsedInput.aiDisclosureText.trim();
  const stripped: EditorChapterOutput[] = reconciled.map((c) => ({
    ...c,
    body_md: stripTrailingAiDisclosure(c.body_md),
  }));

  // 9. R-05 安全装置: 最終章 body_md 末尾に正規の AI 開示文を 1 回だけ付与する。
  const lastIdx = stripped.length - 1;
  const lastChapter = stripped[lastIdx]!;
  let finalChapters: EditorChapterOutput[] = stripped;

  if (!containsDisclosure(lastChapter.body_md, aiText)) {
    const fixedLast: EditorChapterOutput = {
      ...lastChapter,
      body_md: `${lastChapter.body_md.trimEnd()}\n\n${aiText}`,
    };
    finalChapters = [...stripped];
    finalChapters[lastIdx] = fixedLast;
  }

  const result: EditorOutput = {
    chapters: finalChapters,
    ai_disclosure_appended: true,
    ai_disclosure_text: aiText,
  };
  return result;
}

/**
 * 第2段「全体整合パス」。各章に**全章の確定見出し一覧 (TOC)** を渡し、章番号・
 * 相互参照・「次章/前章」予告など**事実として誤っている参照のみ**を本文中で補正する。
 * 内容・主張・構成・文体・文字数は変えない (校閲の品質判断は第1段で完了済み)。
 *
 * 1 章ずつ処理して出力サイズを抑える (全章一括は truncation するため章分割が前提)。
 * 失敗時 (JSON/zod) はその章だけ**第1段の結果をそのまま採用**してフォールバック
 * する (整合補正は best-effort で、本文を失わないことを優先)。
 */
async function runConsistencyPass(
  chapters: EditorChapterOutput[],
  toc: Array<{ index: number; heading: string }>,
  input: EditorInput,
  client: LLMClient,
): Promise<EditorChapterOutput[]> {
  const tocText = toc.map((t) => `第${t.index}章: ${t.heading}`).join('\n');
  const systemPrompt = [
    'あなたは書籍の整合性チェック担当の編集者です。',
    '与えられた「章構成一覧」を唯一の正とし、対象章の本文に含まれる**章番号・章タイトルへの参照、',
    '「次章」「前章」「第N章で詳述」などの予告・相互参照**が章構成一覧と食い違っている箇所だけを修正してください。',
    '',
    '厳守事項:',
    '- 本文の主張・内容・構成・文体・段落構成・文字数は一切変えない。参照の事実誤りのみ最小限に直す。',
    '- 最終章には「次章」予告を書かない（存在しないため、その文を自然に削るか現章のまとめに置き換える）。',
    '- 章番号は章構成一覧の番号に合わせる。存在しない章への参照は、実在する該当章に置き換えるか、章番号を使わない表現にする。',
    '- 出力は JSON のみ。形式: {"chapters":[{"index":<対象章番号>,"heading":"<見出し>","body_md":"<修正後の本文Markdown全文>"}]}',
  ].join('\n');

  const result: EditorChapterOutput[] = [];
  for (const ch of chapters) {
    const userMessage = [
      '【章構成一覧（この番号・タイトルが正）】',
      tocText,
      '',
      `【対象章】第${ch.index}章: ${ch.heading}`,
      ch.index === chapters.length ? '※これは最終章です。次章の予告は書けません。' : '',
      '',
      '【対象章の本文（Markdown）】',
      ch.body_md,
    ].join('\n');

    try {
      const completion = await client.complete({
        role: 'editor',
        genre: input.genre,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      });
      const rawText = completion.text;
      const parsedJson = extractJson(rawText ?? '', hasEditorShape);
      const chRaw = (parsedJson as { chapters?: unknown } | undefined)?.chapters;
      const firstRaw = Array.isArray(chRaw) ? chRaw[0] : undefined;
      const normalizedFirst =
        firstRaw && typeof firstRaw === 'object'
          ? { heading: ch.heading, index: ch.index, ...(firstRaw as Record<string, unknown>) }
          : undefined;
      const validated = normalizedFirst
        ? EditorChapterOutputSchema.safeParse(normalizedFirst)
        : undefined;
      if (validated?.success) {
        result.push({ ...validated.data, index: ch.index, heading: ch.heading });
        continue;
      }
    } catch {
      // フォールバックへ（下）
    }
    // 整合パス失敗時は第1段の結果をそのまま採用（本文を失わない）。
    result.push(ch);
  }
  return result;
}

/**
 * `chapters` 配列を持つ object か (schema-aware extractor 用 predicate)。
 * Writer outline と同様、複数 balanced ブロックから「答えに使うべきラッパー」を
 * 選別するには十分。
 */
function hasEditorShape(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  return Array.isArray(obj.chapters);
}

/**
 * LLM が省きがちなフィールドを救済して zod 通過させる。
 * - chapters[].heading 欠落 → 入力 chapters[index 一致] の heading で補完
 * - ai_disclosure_appended 欠落 → false で補完 (後段の R-05 安全装置で実体検査)
 * - ai_disclosure_text 欠落 → 入力 aiDisclosureText で補完
 * 最終 ai_disclosure_appended / ai_disclosure_text は呼出側で実体検査後に上書きされる。
 */
function normalizePartialOutput(raw: unknown, input: EditorInput): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...obj };

  // chapters[].heading を入力で補完 (index 一致するもの)
  if (Array.isArray(out.chapters)) {
    const inputByIndex = new Map<number, EditorChapterInput>();
    for (const c of input.chapters) inputByIndex.set(c.index, c);
    out.chapters = out.chapters.map((c: unknown) => {
      if (typeof c !== 'object' || c === null) return c;
      const co = c as Record<string, unknown>;
      const copy: Record<string, unknown> = { ...co };
      if (typeof copy.heading !== 'string' || copy.heading.trim().length === 0) {
        const idx = typeof copy.index === 'number' ? copy.index : undefined;
        if (idx !== undefined) {
          const ref = inputByIndex.get(idx);
          if (ref) copy.heading = ref.heading;
        }
      }
      return copy;
    });
  }

  if (typeof out.ai_disclosure_appended !== 'boolean') {
    out.ai_disclosure_appended = false;
  }
  if (typeof out.ai_disclosure_text !== 'string' || (out.ai_disclosure_text as string).length === 0) {
    out.ai_disclosure_text = input.aiDisclosureText;
  }
  return out;
}

/**
 * AI 開示文が body_md に含まれるか (空白・改行差を吸収するため normalize 比較)。
 * 完全一致だと「。」「、」など微妙な違いで誤判定するため、空白圧縮した部分一致で確認。
 */
/**
 * 章末尾に LLM が付与しがちな「AI 生成開示文」段落を除去する。
 * 末尾から走査し、AI 開示マーカーを含む段落 (および直前の見出しのみの段落) を
 * 落とす。本文段落に当たった時点で停止する (本文を誤って削らない)。
 * 馬券免責など AI 開示以外の注意書きは対象外 (ユーザー要望は AI 開示文のみ)。
 */
const AI_DISCLOSURE_MARKER =
  /生成\s*AI|AI\s*生成|AI を活用|AI生成コンテンツ|コンテンツガイドライン|本開示|生成系?AI/;

function stripTrailingAiDisclosure(bodyMd: string): string {
  const paragraphs = bodyMd.split(/\n{2,}/);
  while (paragraphs.length > 0) {
    const last = paragraphs[paragraphs.length - 1]!;
    if (AI_DISCLOSURE_MARKER.test(last)) {
      paragraphs.pop();
      // 直前が「## 免責事項」等の見出しだけの段落なら一緒に落とす。
      const prev = paragraphs[paragraphs.length - 1];
      if (prev !== undefined && /^#{1,6}\s*\S{0,20}$/.test(prev.trim()) && prev.trim().length < 25) {
        paragraphs.pop();
      }
      continue;
    }
    break;
  }
  return paragraphs.join('\n\n').trimEnd();
}

function containsDisclosure(bodyMd: string, aiText: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, '');
  const needle = norm(aiText);
  if (needle.length === 0) return true; // 空文字は always true (zod min(1) で実質起きない)
  return norm(bodyMd).includes(needle);
}

/**
 * F-050 feedback (Array<{body, priority}>) を prompt 注入用の文字列に整形する。
 * Writer chapter と完全同実装。priority 順 (must → should → may) に並べ替え。
 */
function formatFeedback(feedback: RevisionFeedbackItem[] | undefined): string {
  if (!feedback || feedback.length === 0) return '';
  const order = { must: 0, should: 1, may: 2 } as const;
  const sorted = [...feedback].sort((a, b) => order[a.priority] - order[b.priority]);
  return sorted.map((f) => `- [${f.priority.toUpperCase()}] ${f.body}`).join('\n');
}

function buildUserMessage(input: EditorInput): string {
  const lines = [
    `書籍タイトル: ${input.themeContext.title}`,
  ];
  if (input.themeContext.subtitle) {
    lines.push(`副題: ${input.themeContext.subtitle}`);
  }
  lines.push(
    `差別化フック: ${input.themeContext.hook}`,
    `想定読者: ${input.themeContext.target_reader}`,
    `ジャンル: ${genreLabel(input.genre) ?? 'general'}`,
    `章数: ${input.chapters.length}`,
    '',
    '【校閲対象の全章 (JSON 配列)】',
    JSON.stringify(input.chapters, null, 2),
    '',
    '【巻末に必ず挿入する AI 生成開示文 (R-05 / KDP コンテンツガイドライン遵守)】',
    input.aiDisclosureText,
  );

  if (input.feedback && input.feedback.length > 0) {
    lines.push(
      '',
      '【修正コメント — 必ず反映 (must は最優先、should/may は可能な範囲で)】',
      formatFeedback(input.feedback),
    );
  }

  lines.push(
    '',
    '上記の全章を校閲してください。F-005 受入基準 (必ず遵守):',
    ' - 表記ゆれを統一 (例: 「ですます」と「だ・である」混在を「ですます」に統一)',
    ' - 章間の論理整合性を確認し、重複表現や矛盾を解消する',
    ' - 誤字脱字を修正する',
    ' - 各章の `index` / `heading` は入力と完全一致させる (順序・章数を変えない)',
    ' - **最終章の本文末尾に AI 生成開示文を必ず挿入する** (R-05 違反は出版停止リスク)',
    ' - 主な修正点を `diff_summary` (各章) と `overall_notes` (全体) に簡潔に記載する',
    '',
    '出力形式: JSON で以下を返してください。',
    '{',
    '  "chapters": [',
    '    {',
    '      "index": integer,         // 入力と一致',
    '      "heading": string,        // 入力と一致',
    '      "body_md": string,        // 校閲後本文 (Markdown)',
    '      "diff_summary"?: string   // 主な修正点 (任意)',
    '    }, ...',
    '  ],',
    '  "ai_disclosure_appended": boolean, // 最終章末尾に開示文を挿入したか',
    '  "ai_disclosure_text": string,      // 実際に挿入した文字列 (入力エコー推奨)',
    '  "overall_notes"?: string           // 全体総評 (任意)',
    '}',
    '',
    '**出力形式の厳格な制約**:',
    ' - 応答は **必ず単一の JSON オブジェクト** とし、トップレベルキーに `chapters` 配列を含めること',
    ' - JSON 以外のテキスト (前置きコメント、説明、```json``` フェンス等) は応答に含めないこと',
    ' - **JSON 文字列値内では改行は必ず `\\n` (バックスラッシュ + n) でエスケープすること**',
  );
  return lines.join('\n');
}

// ===========================================================================
// JSON 抽出 — writer/outline.ts / writer/chapter.ts と同実装 (schema-aware predicate 対応)
// 将来 lib/json-extract.ts に集約する余地は残すが、現時点では各エージェント側で
// 完結させ重複を許容する (Marketer/Writer/Editor で形が同じため共通化しやすい)。
// ===========================================================================

function extractJson<T = unknown>(
  text: string,
  predicate?: (parsed: unknown) => boolean,
): T | undefined {
  const trimmed = text.trim();
  const candidates: unknown[] = [];

  const direct = tryParse(trimmed);
  if (direct !== undefined) candidates.push(direct);

  const fenceRe = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(trimmed)) !== null) {
    const body = m[1]?.trim();
    if (!body) continue;
    const parsed = tryParse(body);
    if (parsed !== undefined) candidates.push(parsed);
    collectBalanced(body, candidates);
  }

  const openFence = /```(?:[a-zA-Z0-9_-]+)?\s*/.exec(trimmed);
  if (openFence) {
    const after = trimmed.slice(openFence.index + openFence[0].length);
    collectBalanced(after, candidates);
  }

  collectBalanced(trimmed, candidates);

  if (predicate) {
    for (const c of candidates) {
      if (predicate(c)) return c as T;
    }
    return undefined;
  }

  let largest: unknown | undefined;
  let largestSize = -1;
  for (const c of candidates) {
    if (typeof c === 'object' && c !== null) {
      const size = JSON.stringify(c).length;
      if (size > largestSize) {
        largest = c;
        largestSize = size;
      }
    }
  }
  return largest as T | undefined;
}

function collectBalanced(text: string, out: unknown[]): void {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = findMatchingBrace(text, start);
    if (end === -1) continue;
    const parsed = tryParse(text.slice(start, end + 1));
    if (parsed !== undefined) out.push(parsed);
  }
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    try {
      return JSON.parse(sanitizeJsonStringNewlines(s));
    } catch {
      return undefined;
    }
  }
}

/**
 * LLM 応答 JSON 内の string 値に混入する生改行 (\n / \r / \t) を escape する
 * defensive helper。state machine で inString 状態を追跡する。
 */
function sanitizeJsonStringNewlines(text: string): string {
  let result = '';
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escapeNext) {
      result += ch;
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      result += ch;
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      result += ch;
      inString = !inString;
      continue;
    }
    if (inString) {
      if (ch === '\n') {
        result += '\\n';
        continue;
      }
      if (ch === '\r') {
        result += '\\r';
        continue;
      }
      if (ch === '\t') {
        result += '\\t';
        continue;
      }
    }
    result += ch;
  }
  return result;
}
