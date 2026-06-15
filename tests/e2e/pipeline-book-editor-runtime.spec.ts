/**
 * Runtime verification spec for T-04-06 — `pipeline.book.editor` worker task
 *
 * 本タスクは Writer chapter 全章完了後に起動され、全章を統合校閲し巻末に AI 開示文
 * (R-05) を挿入する Editor エージェント (T-04-03) を、worker レイヤから呼び出す
 * 統合タスクである。SP-04 段階ではこれを起動する UI/SA 経路はまだ配線されていないため、
 * 通常の Playwright (ブラウザ操作 → DOM 検証) では F-005 / F-016 / R-05 の worker 統合面を
 * 検証できない。代わりに以下を Node ランタイム上で直接呼び出して検証する:
 *
 *   1. **準備**:
 *      - 一時 Account + ThemeCandidate (status='accepted') + Book (theme_id 結線) +
 *        Chapter 7 行 (status='done', version=1, body_md ~800字 各章) + 内部 Job
 *        (kind='pipeline.book.editor', status='queued') を Prisma で投入。
 *      - AppSettings (singleton) の ai_disclosure_text は seed 値 (DEFAULT_AI_DISCLOSURE_TEXT)
 *        を使う (既存ロウがあればそのまま、無ければ create で確実に存在させる)。
 *
 *   2. **実 worker 実行** (実 LLM コスト ~$0.13 — claude-sonnet-4-6 7 章校閲):
 *      `runPipelineBookEditor(payload, addJob: spy, deps: {})` を直接呼出。
 *      addJob は **mock** (spy) — 後段 thumbnail.text の実行は本 spec の検証対象外、
 *      enqueue の identifier / payload / spec の正しさだけを spy で記録する。
 *
 *   3. **検証** (F-005 / F-016 / R-05 受入基準 + docs/05 §5.3.5):
 *      - 内部 Job: status='done', started_at/finished_at 充足, error=null,
 *        result_json={ revisions_count: 7, ai_disclosure_appended: true,
 *          thumbnail_text_job_id: <child job id> }
 *      - Chapter 7 行すべて: version=2, body_md は校閲後 (元 draft と差分があり得る),
 *        char_count = codepoint length, updated_at が前進
 *      - ChapterRevision 7 行 INSERT: version=旧 (1), body_md=旧 draft, reason=`editor:<jobId>`,
 *        chapter_id / book_id が一致
 *      - **最終章** body_md の末尾近傍に ai_disclosure_text が含まれる (R-05)
 *      - token_usage 1 行 INSERT: role='editor', provider='anthropic',
 *        model=claude-*, book_id=bookId, job_id=jobId, input_tokens>1000
 *      - **thumbnail.text 子 Job** が 1 行 INSERT:
 *        kind='pipeline.book.thumbnail.text', parent_job_id=editor jobId,
 *        status='queued', payload_json.book_id=bookId
 *      - addJob spy が 'pipeline.book.thumbnail.text' identifier で 1 回呼出され、
 *        spec={maxAttempts:3}, payload={book_id, job_id=thumbnail jobId}
 *      - BookLock が解放されている (book_id 行が無い)
 *
 *   4. **クリーンアップ**:
 *      順序: token_usage → ChapterRevision → Chapter → BookLock → Job (book_id 紐付け全て) →
 *      Book → ThemeCandidate → Account を delete / deleteMany。AppSettings は singleton で
 *      他テストと共有のため触らない。
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner として
 *     借用し、@a2p/db と apps/worker/.../pipeline-book-editor を直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と
 *     .env.local (ANTHROPIC_API_KEY / DATABASE_URL / AUTH_*) が前提。
 *     ModelAssignment (role='editor', genre=null, provider='anthropic',
 *     model='claude-sonnet-4-6') + Prompt (role='editor', genre=null active) が
 *     seed 済であることも前提。AppSettings singleton 行も seed 済 (ai_disclosure_text あり)。
 *     addJob は **mock** で受ける (graphile-worker への実 enqueue は本 spec の検証対象外、
 *     enqueue 呼出の identifier / payload / spec の正しさだけを spy で記録する)。
 *
 * コスト: editBook 1 回 = 7 章 × ~800 字入力 (~5600 字 ≒ input ~4000 tokens) +
 *         output ~7000-10000 tokens (claude-sonnet-4-6) ≒ ~$0.13 / run (~20 円)。
 *         editor.invalid_output / editor.chapters_mismatch の LLM 揺れに最大 3 回 retry。
 *         CI ではスキップ可 (PLAYWRIGHT_SKIP_REAL_API=1)。
 *
 * 設計判断 (本 spec 固有):
 *  - 章数 7 (F-003 最小章数, EditorInputSchema min(7) 制約)。各章 ~800 字 codepoint で
 *    LLM 入力トークン量を抑えつつ EditorChapterInputSchema min(500) を確実に上回る。
 *  - 単一テストケース (1 worker 呼出 = 全観点を 1 度に検証)。retry は worker 内部ではなく
 *    本 spec で wrap して、editor.* AgentError 限定で最大 3 回 retry。
 *  - 二重 enqueue ガード (R-05 二重防衛) は **unit test 側で mock 検証済**。実 LLM
 *    1 回 = $0.13 のコスト下では、本 spec ではガード経路は実行しない。
 *  - 校閲品質 (表記ゆれ修正 / 文体統一) の評価は Quality Judge (Phase 2) の責務であり、
 *    本 spec では「校閲が行われた → 7 行すべて ChapterRevision に旧版退避 + version=2」
 *    で十分とする。body_md が draft と完全一致でも「LLM がそう判断した」だけで合格。
 *
 * 関連:
 *  - docs/02 §F-005 (Editor) / §F-016 (リトライ・部分再開) / §R-05 (AI 開示文)
 *  - docs/05 §5.3.5 (pipeline.book.editor)
 *  - apps/worker/src/tasks/pipeline-book-editor.ts
 *  - apps/worker/__tests__/pipeline-book-editor.test.ts (20 unit tests)
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { invalidateApiKeyCache } from '@a2p/agents/lib/get-api-key';

import {
  runPipelineBookEditor,
  PIPELINE_BOOK_EDITOR_TASK_NAME,
} from '../../apps/worker/src/tasks/pipeline-book-editor.js';
import { PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME } from '../../apps/worker/src/tasks/pipeline-book-thumbnail-text.js';

const SKIP_REAL_API = process.env.PLAYWRIGHT_SKIP_REAL_API === '1';
const TEST_TAG = 't-04-06-runtime-test';

/**
 * addJob spy. graphile-worker.helpers.addJob と同形のシグネチャ。
 * 呼出履歴 (identifier / payload / spec) を records に蓄積する。
 */
function makeAddJobSpy() {
  const records: Array<{
    identifier: string;
    payload: unknown;
    spec: Record<string, unknown> | undefined;
  }> = [];
  const fn = async (
    identifier: string,
    payload: unknown,
    spec?: Record<string, unknown>,
  ): Promise<unknown> => {
    records.push({ identifier, payload, spec });
    return undefined;
  };
  return { fn, records };
}

/**
 * 指定文字数 (codepoint) の章本文 Markdown を生成。Writer chapter 出力を模擬。
 * editor-runtime.spec.ts (T-04-03) と同じパターン。
 */
function buildDummyBody(chars: number, index: number, heading: string): string {
  const header = `## ${heading}\n\n`;
  const sentenceA = '本章では本書のテーマについて具体的に解説していきます。';
  const sentenceB = '読者は本章を通じて重要な視点を獲得することができるだろう。';
  let body = header;
  while ([...body].length < chars) {
    body += sentenceA + sentenceB + '\n\n';
  }
  return body;
}

/** 空白を圧縮した部分一致判定 (editor 本体の containsDisclosure と同等)。 */
function normalizedIncludes(haystack: string, needle: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, '');
  return norm(haystack).includes(norm(needle));
}

/** 7 章 (F-003 最小, EditorInputSchema min(7) 整合)。各章 ~800 字。 */
const SEVEN_CHAPTERS = [
  { index: 1, heading: '第1章 はじめに — 変化する働き方', body_md: buildDummyBody(800, 1, '第1章 はじめに') },
  { index: 2, heading: '第2章 信頼の土台を作る', body_md: buildDummyBody(800, 2, '第2章 信頼の土台を作る') },
  { index: 3, heading: '第3章 1on1 の設計と実践', body_md: buildDummyBody(800, 3, '第3章 1on1 の設計と実践') },
  { index: 4, heading: '第4章 非同期コミュニケーション', body_md: buildDummyBody(800, 4, '第4章 非同期コミュニケーション') },
  { index: 5, heading: '第5章 評価と成長の支援', body_md: buildDummyBody(800, 5, '第5章 評価と成長の支援') },
  { index: 6, heading: '第6章 チーム文化の醸成', body_md: buildDummyBody(800, 6, '第6章 チーム文化の醸成') },
  { index: 7, heading: '第7章 まとめ — これからの一歩', body_md: buildDummyBody(800, 7, '第7章 まとめ — これからの一歩') },
];

test.describe('runtime: pipeline.book.editor worker task (T-04-06)', () => {
  // 7 章 × ~800 字校閲 (input ~5600 字 + output ~7000-10000 字)。
  // editor 60-180s + retry × 3 = 600s 上限。
  test.setTimeout(600_000);

  let accountId: string;
  let themeId: string;
  let bookId: string;
  let jobId: string;
  const chapterIdsByIndex = new Map<number, string>();
  /** AppSettings から読んだ ai_disclosure_text (検証で使う)。 */
  let aiDisclosureText: string;

  test.beforeAll(async () => {
    if (SKIP_REAL_API) return;
    invalidateApiKeyCache();

    // 0) AppSettings (singleton) 存在確認 — seed 済の想定。存在しなければ create。
    const existingSettings = await prisma.appSettings.findUnique({
      where: { id: 'singleton' },
    });
    if (!existingSettings) {
      throw new Error(
        'AppSettings singleton row not found — run `pnpm db:seed` first',
      );
    }
    const txt = (existingSettings.ai_disclosure_text ?? '').trim();
    if (txt.length === 0) {
      throw new Error('AppSettings.ai_disclosure_text is empty — fix seed');
    }
    aiDisclosureText = txt;

    // 1) 一時 Account
    const account = await prisma.account.create({
      data: {
        pen_name: `e2e-pipe-editor-${Date.now()}`,
        genre_policy_json: {
          primary_genre: 'business',
          ratio: { business: 1 },
          focus_themes: ['remote_work'],
        },
        status: 'archived',
      },
    });
    accountId = account.id;

    // 2) 一時 ThemeCandidate (status='accepted', genre='business')
    const theme = await prisma.themeCandidate.create({
      data: {
        account_id: accountId,
        theme_session_id: `${TEST_TAG}-session-${Date.now()}`,
        genre: 'business',
        title: 'リモートワーク時代のチームマネジメント実践ガイド',
        subtitle: '心理的安全性と成果を両立する 7 つのフレームワーク',
        hook: 'リモート/ハイブリッド環境で信頼ベースの組織を作る実務マニュアル',
        target_reader: '中小企業〜大企業の課長・部長クラス（30〜50歳）',
        competitors_json: [],
        signals_json: {
          reasoning: 'リモート定着で需要継続',
          market_score: 70,
          predicted_chapters: 7,
          search_keywords: ['リモートワーク', 'マネジメント'],
          search_volume: 15000,
          rank_estimate: 30000,
          sources: ['amazon_search'],
        },
        status: 'accepted',
        decided_at: new Date(),
      },
    });
    themeId = theme.id;

    // 3) 一時 Book (theme_id 結線済、status='running' = writer 完了想定)
    const book = await prisma.book.create({
      data: {
        account_id: accountId,
        theme_id: themeId,
        title: theme.title,
        subtitle: theme.subtitle,
        status: 'running',
        prompt_version_ids_json: {},
        model_assignment_snapshot: {},
      },
    });
    bookId = book.id;

    // 4) Chapter 7 行 (status='done', version=1) — Writer chapter 完了相当
    for (const ch of SEVEN_CHAPTERS) {
      const created = await prisma.chapter.create({
        data: {
          book_id: bookId,
          index: ch.index,
          heading: ch.heading,
          body_md: ch.body_md,
          status: 'done',
          char_count: [...ch.body_md].length,
          version: 1,
        },
      });
      chapterIdsByIndex.set(ch.index, created.id);
    }

    // 5) 内部 Job (kind='pipeline.book.editor', status='queued')
    const job = await prisma.job.create({
      data: {
        kind: PIPELINE_BOOK_EDITOR_TASK_NAME,
        book_id: bookId,
        status: 'queued',
        payload_json: {
          source: 'e2e/pipeline-book-editor-runtime.spec.ts',
          book_id: bookId,
        },
      },
    });
    jobId = job.id;

    // 既存 BookLock 残骸を除去
    await prisma.bookLock
      .deleteMany({ where: { book_id: bookId } })
      .catch(() => undefined);
  });

  test.afterAll(async () => {
    if (SKIP_REAL_API) return;

    // 順序: token_usage → ChapterRevision → Chapter → BookLock → Job → Book → Theme → Account
    if (bookId) {
      await prisma.tokenUsage
        .deleteMany({ where: { book_id: bookId } })
        .catch(() => undefined);
      await prisma.chapterRevision
        .deleteMany({ where: { book_id: bookId } })
        .catch(() => undefined);
      await prisma.chapter
        .deleteMany({ where: { book_id: bookId } })
        .catch(() => undefined);
      await prisma.bookLock
        .deleteMany({ where: { book_id: bookId } })
        .catch(() => undefined);
      // editor Job + 子 thumbnail.text Job 含めて全削除
      await prisma.job
        .deleteMany({ where: { book_id: bookId } })
        .catch(() => undefined);
      await prisma.book.delete({ where: { id: bookId } }).catch(() => undefined);
    }
    if (themeId) {
      await prisma.themeCandidate
        .delete({ where: { id: themeId } })
        .catch(() => undefined);
    }
    if (accountId) {
      await prisma.account
        .delete({ where: { id: accountId } })
        .catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  test('runPipelineBookEditor 実 LLM 実行 → 7 章 校閲 (version++) + ChapterRevision 退避 + AI 開示文巻末挿入 + thumbnail.text enqueue + token_usage 1 行', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // --- 事前確認 ---------------------------------------------------------
    const initialJob = await prisma.job.findUnique({ where: { id: jobId } });
    expect(initialJob?.status).toBe('queued');

    const initialChapters = await prisma.chapter.findMany({
      where: { book_id: bookId },
      orderBy: { index: 'asc' },
    });
    expect(initialChapters).toHaveLength(7);
    for (const c of initialChapters) {
      expect(c.version).toBe(1);
      expect(c.status).toBe('done');
    }
    // 元の body_md を保存しておく (校閲後の差分検証で参照)
    const originalBodyByIndex = new Map<number, string>();
    for (const c of initialChapters) {
      originalBodyByIndex.set(c.index, c.body_md);
    }

    const initialRevisions = await prisma.chapterRevision.count({
      where: { book_id: bookId },
    });
    expect(initialRevisions).toBe(0);

    const initialUsage = await prisma.tokenUsage.count({
      where: { job_id: jobId },
    });
    expect(initialUsage).toBe(0);

    const initialThumbnailJobs = await prisma.job.count({
      where: { book_id: bookId, kind: PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME },
    });
    expect(initialThumbnailJobs).toBe(0);

    // --- 実 worker 呼出 (retry wrap) -------------------------------------
    // editor.invalid_output / editor.chapters_mismatch の LLM 揺れに最大 3 回 retry。
    // 失敗時は token_usage / ChapterRevision / 部分 Chapter 更新を掃除して内部 Job を queued に戻す。
    const addJobSpy = makeAddJobSpy();

    const runWithRetry = async () => {
      const MAX_ATTEMPTS = 3;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          await runPipelineBookEditor(
            { book_id: bookId, job_id: jobId },
            addJobSpy.fn,
          );
          return;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.warn(
            `[T-04-06 editor worker] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`,
          );
          const details = (err as { details?: { rawText?: string } }).details;
          if (details?.rawText) {
            // eslint-disable-next-line no-console
            console.warn(
              `[T-04-06 attempt ${attempt}] rawText (first 2000 chars):\n${details.rawText.slice(0, 2000)}`,
            );
          }
          const isEditorAgentError = msg.startsWith('editor.');
          if (!isEditorAgentError) throw err;
          if (attempt === MAX_ATTEMPTS) break;

          // クリーンアップ: token_usage / ChapterRevision / addJob spy / 部分書込み Chapter
          await prisma.tokenUsage
            .deleteMany({ where: { job_id: jobId } })
            .catch(() => undefined);
          await prisma.chapterRevision
            .deleteMany({ where: { book_id: bookId } })
            .catch(() => undefined);
          // Chapter は元 body / version=1 / char_count に戻す
          for (const ch of SEVEN_CHAPTERS) {
            await prisma.chapter
              .updateMany({
                where: { book_id: bookId, index: ch.index },
                data: {
                  body_md: ch.body_md,
                  version: 1,
                  char_count: [...ch.body_md].length,
                },
              })
              .catch(() => undefined);
          }
          // thumbnail.text 子 Job を削除 (前回 enqueue されている可能性)
          await prisma.job
            .deleteMany({
              where: {
                book_id: bookId,
                kind: PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME,
              },
            })
            .catch(() => undefined);
          // 内部 Job を queued に戻す
          await prisma.job.update({
            where: { id: jobId },
            data: {
              status: 'queued',
              started_at: null,
              finished_at: null,
              error: null,
              result_json: undefined as unknown as object,
            },
          });
          // BookLock 残骸を除去
          await prisma.bookLock
            .deleteMany({ where: { book_id: bookId } })
            .catch(() => undefined);
          // addJob spy をクリア (records 直接 splice)
          addJobSpy.records.splice(0, addJobSpy.records.length);
        }
      }
      if (lastErr) throw lastErr;
    };

    await runWithRetry();

    // --- 検証 1: 内部 Job done + result_json --------------------------------
    const finalJob = await prisma.job.findUnique({ where: { id: jobId } });
    expect(finalJob).not.toBeNull();
    expect(finalJob!.status).toBe('done');
    expect(finalJob!.started_at).not.toBeNull();
    expect(finalJob!.finished_at).not.toBeNull();
    expect(finalJob!.error).toBeNull();
    const result = finalJob!.result_json as {
      revisions_count: number;
      ai_disclosure_appended: boolean;
      thumbnail_text_job_id: string | null;
    };
    expect(result.revisions_count).toBe(7);
    expect(result.ai_disclosure_appended).toBe(true);
    expect(typeof result.thumbnail_text_job_id).toBe('string');
    expect(result.thumbnail_text_job_id!.length).toBeGreaterThan(0);

    // --- 検証 2: Chapter 7 行 version=2 + body_md 更新済 + char_count 一致 ---
    const editedChapters = await prisma.chapter.findMany({
      where: { book_id: bookId },
      orderBy: { index: 'asc' },
    });
    expect(editedChapters).toHaveLength(7);
    for (const c of editedChapters) {
      expect(c.version).toBe(2);
      expect(typeof c.body_md).toBe('string');
      expect(c.body_md.length).toBeGreaterThan(0);
      // codepoint length 一致
      expect(c.char_count).toBe([...c.body_md].length);
      // body_md は校閲後 (元と完全一致でも LLM がそう判断しただけなので合格扱い、
      // ただし min(500) は EditorOutputSchema 側で強制済)。
      expect([...c.body_md].length).toBeGreaterThanOrEqual(500);
    }

    // --- 検証 3: ChapterRevision 7 行 INSERT (旧 body 退避) -----------------
    const revisions = await prisma.chapterRevision.findMany({
      where: { book_id: bookId },
      orderBy: { created_at: 'asc' },
    });
    expect(revisions).toHaveLength(7);
    const reason = `editor:${jobId}`;
    for (const r of revisions) {
      expect(r.book_id).toBe(bookId);
      expect(r.version).toBe(1); // 旧 version
      expect(r.reason).toBe(reason);
      expect(typeof r.body_md).toBe('string');
      expect(r.body_md.length).toBeGreaterThan(0);
      // chapter_id は SEVEN_CHAPTERS のいずれかと一致
      const chapterId = r.chapter_id;
      const matchedIndex = [...chapterIdsByIndex.entries()].find(
        ([, id]) => id === chapterId,
      )?.[0];
      expect(matchedIndex).toBeDefined();
      // 旧 body_md と revision.body_md が一致
      const originalBody = originalBodyByIndex.get(matchedIndex!);
      expect(originalBody).toBeDefined();
      expect(r.body_md).toBe(originalBody);
    }

    // --- 検証 4: 最終章 body_md 末尾近傍に ai_disclosure_text が含まれる (R-05) ---
    const lastChapter = editedChapters[editedChapters.length - 1]!;
    expect(lastChapter.index).toBe(7);
    expect(normalizedIncludes(lastChapter.body_md, aiDisclosureText)).toBe(true);

    // --- 検証 5: token_usage 1 行 INSERT (role='editor', model=claude-*) ----
    const usageRows = await prisma.tokenUsage.findMany({
      where: { job_id: jobId },
    });
    expect(usageRows).toHaveLength(1);
    const usage = usageRows[0]!;
    expect(usage.provider).toBe('anthropic');
    expect(usage.role).toBe('editor');
    expect(usage.book_id).toBe(bookId);
    expect(usage.job_id).toBe(jobId);
    expect(usage.model).toMatch(/^claude-/);
    expect(usage.input_tokens).toBeGreaterThan(1000);
    expect(usage.output_tokens).toBeGreaterThan(0);
    expect(usage.image_count).toBe(0);

    // --- 検証 6: thumbnail.text 子 Job 1 行 INSERT --------------------------
    const thumbnailJobs = await prisma.job.findMany({
      where: { book_id: bookId, kind: PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME },
    });
    expect(thumbnailJobs).toHaveLength(1);
    const thumbnailJob = thumbnailJobs[0]!;
    expect(thumbnailJob.parent_job_id).toBe(jobId);
    expect(thumbnailJob.status).toBe('queued');
    expect(thumbnailJob.id).toBe(result.thumbnail_text_job_id);
    const thumbnailPayload = thumbnailJob.payload_json as { book_id: string };
    expect(thumbnailPayload.book_id).toBe(bookId);

    // --- 検証 7: addJob spy が thumbnail.text 1 回呼出 ----------------------
    const thumbAddCalls = addJobSpy.records.filter(
      (r) => r.identifier === PIPELINE_BOOK_THUMBNAIL_TEXT_TASK_NAME,
    );
    expect(thumbAddCalls).toHaveLength(1);
    const thumbCall = thumbAddCalls[0]!;
    expect(thumbCall.spec).toEqual({ maxAttempts: 3 });
    const callPayload = thumbCall.payload as { book_id: string; job_id: string };
    expect(callPayload.book_id).toBe(bookId);
    expect(callPayload.job_id).toBe(thumbnailJob.id);

    // --- 検証 8: BookLock 解放 (book_id 行が無い) ----------------------------
    const remainingLocks = await prisma.bookLock.count({
      where: { book_id: bookId },
    });
    expect(remainingLocks).toBe(0);

    // --- デバッグログ -------------------------------------------------------
    // eslint-disable-next-line no-console
    console.log(
      `[T-04-06 editor worker] jobId=${jobId} bookId=${bookId} ` +
        `revisions_count=${result.revisions_count} ` +
        `ai_disclosure_appended=${result.ai_disclosure_appended} ` +
        `thumbnail_text_job_id=${result.thumbnail_text_job_id}`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[T-04-06 editor token_usage] model=${usage.model} input=${usage.input_tokens} ` +
        `output=${usage.output_tokens} cached=${usage.cached_input_tokens} ` +
        `cost_jpy=${usage.cost_jpy.toString()}`,
    );
    for (const c of editedChapters) {
      // eslint-disable-next-line no-console
      console.log(
        `[T-04-06 ch.${c.index}] version=${c.version} char_count=${c.char_count} ` +
          `"${c.heading.slice(0, 40)}"`,
      );
    }
  });
});
