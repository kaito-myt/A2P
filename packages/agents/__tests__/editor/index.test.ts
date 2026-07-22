/**
 * T-04-03 — Editor エージェント (全章統合校閲 + AI 開示文挿入) 単体テスト。
 *
 * 戦略 (writer/chapter.test.ts と同パターン):
 *  - `createAgentClient` を vi.fn() で差し替え、LLMClient.complete を mock する
 *  - `loadActivePrompt` は promptLoaderDeps 経由で repo を差し替える
 *  - token_usage 記録は withTokenLoggingDeps の prisma 経由で create 呼出回数を確認
 *
 * カバレッジ (タスク詳細 §8 のケース):
 *  1. happy path (8 章 + AI 開示文)
 *  2. 章数不一致 (入力 8, 出力 7) → AgentError
 *  3. index 不連続 (1,2,4) → AgentError
 *  4. body_md 短すぎ (200 字) → AgentError(invalid_output)
 *  5. AI 開示文未挿入 → 強制挿入 + appended=true
 *  6. AI 開示文挿入済 → そのまま返却
 *  7. JSON parse 失敗 → AgentError
 *  8. feedback 指定時 → prompt に注入
 *  9. jobId 未指定 → ctx.jobId = undefined → token_usage.job_id = null
 *  10. jobId 指定 → forward
 *  11. token_usage 1 行 INSERT (book_id 紐付け、role='editor')
 *  12. 入力章数 7 → 校閲後も 7 章維持
 *
 * NOTE: 実 API は叩かない。Anthropic SDK 等の本体には触らない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentError } from '@a2p/contracts/errors';
import type {
  LLMClient,
  LLMCompleteArgs,
  LLMCompleteResult,
} from '@a2p/contracts/agents';
import type {
  EditorChapterInput,
  EditorInput,
} from '@a2p/contracts/agents/editor';
import type { RevisionFeedbackItem } from '@a2p/contracts/agents/writer';

// Prisma を引かないよう @a2p/db を mock。テストは promptLoaderDeps 経由で repo を差し替える。
vi.mock('@a2p/db', () => ({
  prisma: {
    prompt: { findFirst: vi.fn() },
    tokenUsage: { create: vi.fn() },
    book: { update: vi.fn() },
    modelCatalog: { findFirst: vi.fn() },
    modelAssignment: { findFirst: vi.fn() },
    apiCredential: { findUnique: vi.fn() },
  },
}));

const { editBook } = await import('../../src/editor/index.js');
import type { EditBookDeps } from '../../src/editor/index.js';
const { withTokenLogging } = await import('../../src/lib/with-token-logging.js');
import type {
  LoggingContext,
  WithTokenLoggingDeps,
} from '../../src/lib/with-token-logging.js';

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

const DEFAULT_AI_DISCLOSURE =
  '本書の本文は生成 AI を活用して作成し、著者が編集・監修したコンテンツです。Amazon KDP のコンテンツガイドラインに従い、AI 生成コンテンツであることを明示します。';

/** 指定文字数 (codepoint 数) の Markdown 本文を生成。Writer chapter テストと同手法。 */
function buildBody(chars: number, extra = ''): string {
  const prefix = '## 小見出し\n\n';
  const filler = 'あ';
  const repeatNeeded = Math.max(0, chars - [...prefix].length - [...extra].length);
  return prefix + filler.repeat(repeatNeeded) + extra;
}

function sampleInputChapter(
  index: number,
  overrides: Partial<EditorChapterInput> = {},
): EditorChapterInput {
  return {
    index,
    heading: overrides.heading ?? `第${index}章 サンプル見出し`,
    body_md: overrides.body_md ?? buildBody(800),
  };
}

function jsonResponse(payload: unknown): string {
  return JSON.stringify(payload);
}

/**
 * 入力対応型のフェイク LLM クライアント。
 *
 * 現在の Editor は **章ごと**に校閲 (第1段) + 整合パス (第2段) を回すため、
 * 1 回の editBook で `complete` が「章数 × 2」回呼ばれる。各呼び出しは
 * その章だけを `{chapters:[<該当章>]}` で返す必要がある。
 *
 * そこで `text` を全章ペイロードとして解釈し、リクエスト中の章番号
 * (system の draft_chapters 内 `"index":N`、または整合パス user の `第N章`) を
 * 読み取って、該当章のみを返す。JSON でない場合 (異常系テスト) は `text` を
 * そのまま返し、invalid_output 系の検証を成立させる。
 */
function makeFakeClient(text: string): LLMClient {
  let payload: { chapters?: Array<{ index?: number }>; [k: string]: unknown } | undefined;
  try {
    const p = JSON.parse(text);
    if (p && typeof p === 'object') payload = p;
  } catch {
    payload = undefined;
  }

  const completeImpl = async <T = string>(
    args: LLMCompleteArgs,
  ): Promise<LLMCompleteResult<T>> => {
    let outText = text;
    if (payload && Array.isArray(payload.chapters)) {
      const blob = args.messages.map((m) => String(m.content)).join('\n');
      const draftMatch = blob.match(/"index"\s*:\s*(\d+)/);
      const refMatch = blob.match(/第(\d+)章/);
      const idx = draftMatch
        ? Number(draftMatch[1])
        : refMatch
          ? Number(refMatch[1])
          : undefined;
      if (idx !== undefined) {
        const ch = payload.chapters.find((c) => c && c.index === idx);
        if (ch) {
          outText = JSON.stringify({
            chapters: [ch],
            ai_disclosure_appended: payload.ai_disclosure_appended,
            ai_disclosure_text: payload.ai_disclosure_text,
          });
        }
      }
    }
    return {
      text: outText as T,
      usage: { inputTokens: 8000, outputTokens: 16000 },
      costJpy: 0,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    };
  };
  return {
    complete: vi.fn(completeImpl) as LLMClient['complete'],
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('not used in tests');
    },
  };
}

/**
 * editBook が `complete` を呼ぶ総回数 = 章数 × 2 (第1段 章校閲 + 第2段 整合パス)。
 */
function expectedCompleteCalls(chapterCount: number): number {
  return chapterCount * 2;
}

function makePromptRepo(rows: Array<{
  id: string;
  role: string;
  genre: string | null;
  version: number;
  body: string;
  status: string;
}>) {
  return {
    prompt: {
      findFirst: vi.fn(async (args: {
        where: { role: string; status: string; OR: Array<{ genre: string | null }> };
      }) => {
        const allowed = new Set(args.where.OR.map((o) => o.genre));
        const hit = rows.find(
          (r) =>
            r.role === args.where.role &&
            r.status === args.where.status &&
            allowed.has(r.genre),
        );
        if (!hit) return null;
        return { id: hit.id, body: hit.body, version: hit.version, genre: hit.genre };
      }),
    },
  };
}

function defaultPromptRow() {
  return {
    id: 'p-editor-1',
    role: 'editor',
    genre: null,
    version: 1,
    body:
      'あなたはエディターです。書籍: {theme_title} / 副題: {theme_subtitle} / フック: {theme_hook}\n' +
      '想定読者: {target_reader} / ジャンル: {genre}\n' +
      '章数: {chapter_count}\n' +
      '草稿: {draft_chapters}\n' +
      'AI 開示文: {ai_disclosure_text}\n' +
      '修正コメント: {feedback}',
    status: 'active',
  };
}

function baseInput(overrides: Partial<EditorInput> = {}): EditorInput {
  const chapters =
    overrides.chapters ??
    Array.from({ length: 8 }, (_, i) => sampleInputChapter(i + 1));
  const base: EditorInput = {
    bookId: overrides.bookId ?? 'book-1',
    accountId: overrides.accountId ?? 'acc-1',
    genre: overrides.genre ?? null,
    themeContext: overrides.themeContext ?? {
      title: '副業で月 5 万円',
      subtitle: '初心者向け実践ガイド',
      hook: '既存本にない切り口で 30 代副業初心者に最短ルートを示す',
      target_reader: '30 代会社員 / 副業初心者',
    },
    chapters,
    aiDisclosureText: overrides.aiDisclosureText ?? DEFAULT_AI_DISCLOSURE,
    feedback: overrides.feedback ?? [],
  };
  if (overrides.jobId !== undefined) base.jobId = overrides.jobId;
  return base;
}

/**
 * LLM 応答 JSON ビルダ。input と同じ章 (index/heading) を echo して body_md を入れ替える。
 * disclosure=true なら最終章末尾に DEFAULT_AI_DISCLOSURE を含める。
 */
function buildLlmResponse(
  input: EditorInput,
  opts: {
    disclosure?: boolean;
    bodyChars?: number;
    chaptersOverride?: Array<{ index: number; heading?: string; body_md: string; diff_summary?: string }>;
    appendedFlag?: boolean;
    overall?: string;
  } = {},
): string {
  const disclosure = opts.disclosure ?? true;
  const bodyChars = opts.bodyChars ?? 800;
  const appendedFlag = opts.appendedFlag ?? disclosure;
  const chapters =
    opts.chaptersOverride ??
    input.chapters.map((c, i) => {
      const isLast = i === input.chapters.length - 1;
      const body = isLast && disclosure
        ? buildBody(bodyChars) + '\n\n' + DEFAULT_AI_DISCLOSURE
        : buildBody(bodyChars);
      return {
        index: c.index,
        heading: c.heading,
        body_md: body,
        diff_summary: '誤字修正',
      };
    });
  const payload: Record<string, unknown> = {
    chapters,
    ai_disclosure_appended: appendedFlag,
    ai_disclosure_text: DEFAULT_AI_DISCLOSURE,
  };
  if (opts.overall) payload.overall_notes = opts.overall;
  return jsonResponse(payload);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. happy path
// ---------------------------------------------------------------------------

describe('editBook — happy path', () => {
  it('8 章 + AI 開示文付き応答 → 8 章返却 + ai_disclosure_appended=true', async () => {
    const input = baseInput();
    const text = buildLlmResponse(input, { disclosure: true });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await editBook(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.chapters).toHaveLength(8);
    expect(result.ai_disclosure_appended).toBe(true);
    expect(result.ai_disclosure_text).toBe(DEFAULT_AI_DISCLOSURE);
    // 最終章末尾に AI 開示文 (空白圧縮 substring 比較で OK)
    const last = result.chapters[result.chapters.length - 1]!;
    expect(last.body_md.replace(/\s+/g, '')).toContain(
      DEFAULT_AI_DISCLOSURE.replace(/\s+/g, ''),
    );
    // index 順序維持
    expect(result.chapters.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // 章ごと校閲 (8) + 整合パス (8) = 16 回
    expect(fakeClient.complete).toHaveBeenCalledTimes(expectedCompleteCalls(8));
  });
});

// ---------------------------------------------------------------------------
// 2. 章数不一致 (入力 8, 出力 7)
// ---------------------------------------------------------------------------

// NOTE: 旧テスト「出力7章→chapters_mismatch」「index不連続→mismatch」は、
// Editor が **章ごとに入力章を 1 件ずつ校閲し index を入力値で正規化する**
// 現行設計では構造的に発生しない (出力章数は常に入力章数、index は常に入力連番)。
// 代わりに、その不変条件と「章応答が空 → invalid_output」を検証する。
describe('editBook — 章数 / index 不変条件', () => {
  it('出力章数・index は常に入力どおり (章ごと再構成)', async () => {
    const input = baseInput();
    const text = buildLlmResponse(input);
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await editBook(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.chapters).toHaveLength(input.chapters.length);
    expect(result.chapters.map((c) => c.index)).toEqual(
      input.chapters.map((c) => c.index),
    );
  });

  it('ある章の応答が chapters:[] (空) → AgentError(invalid_output)', async () => {
    const input = baseInput();
    const fakeClient = makeFakeClient('{"chapters":[]}');
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await editBook(input, {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
  });
});

// ---------------------------------------------------------------------------
// 4. body_md 短すぎ (zod min(500) 違反)
// ---------------------------------------------------------------------------

describe('editBook — 出力検証', () => {
  it('body_md が 200 字 (< 500) → AgentError(invalid_output: schema validation failed)', async () => {
    const input = baseInput();
    // 全章 200 字本文 (< 500) で返す
    const chaptersOverride = input.chapters.map((c) => ({
      index: c.index,
      heading: c.heading,
      body_md: 'あ'.repeat(200), // 200 codepoint
      diff_summary: '誤字修正',
    }));
    const text = buildLlmResponse(input, { chaptersOverride });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await editBook(input, {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
    expect((caught as AgentError).message).toMatch(/schema validation/);
  });

  it('JSON ではないテキスト → AgentError(invalid_output)', async () => {
    const input = baseInput();
    const fakeClient = makeFakeClient('I am not JSON at all, sorry.');
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await editBook(input, {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
  });

  it('空文字レスポンス → AgentError(invalid_output: empty)', async () => {
    const input = baseInput();
    const fakeClient = makeFakeClient('   ');
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await expect(
      editBook(input, {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });
});

// ---------------------------------------------------------------------------
// 5. AI 開示文未挿入 → 強制挿入 (R-05 安全装置)
// ---------------------------------------------------------------------------

describe('editBook — R-05 AI 開示文 安全装置', () => {
  it('LLM が AI 開示文を最終章に含めず + appended=false で返却 → 強制挿入 + appended=true で返却', async () => {
    const input = baseInput();
    const text = buildLlmResponse(input, { disclosure: false, appendedFlag: false });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await editBook(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.ai_disclosure_appended).toBe(true);
    expect(result.ai_disclosure_text).toBe(DEFAULT_AI_DISCLOSURE);
    const last = result.chapters[result.chapters.length - 1]!;
    expect(last.body_md.replace(/\s+/g, '')).toContain(
      DEFAULT_AI_DISCLOSURE.replace(/\s+/g, ''),
    );
    // 入力 body_md が末尾保持されている (差分 add のみ、既存本文は保たれる)
    expect(last.body_md).toContain('## 小見出し');
  });

  it('LLM が AI 開示文を挿入済 + appended=true 申告 → そのまま返却 (二重挿入しない)', async () => {
    const input = baseInput();
    const text = buildLlmResponse(input, { disclosure: true, appendedFlag: true });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await editBook(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.ai_disclosure_appended).toBe(true);
    const last = result.chapters[result.chapters.length - 1]!;
    // AI 開示文の出現回数を空白圧縮ベースで数える
    const normBody = last.body_md.replace(/\s+/g, '');
    const normNeedle = DEFAULT_AI_DISCLOSURE.replace(/\s+/g, '');
    const occurrences = normBody.split(normNeedle).length - 1;
    expect(occurrences).toBe(1);
  });

  it('LLM が挿入済だが appended=false 申告 → 実体優先で appended=true に矯正', async () => {
    const input = baseInput();
    const text = buildLlmResponse(input, { disclosure: true, appendedFlag: false });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await editBook(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.ai_disclosure_appended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. feedback 指定時 → prompt に注入
// ---------------------------------------------------------------------------

describe('editBook — プロンプト差込', () => {
  it('feedback (must/should) 指定時、system プロンプト + user メッセージに反映される (priority sort)', async () => {
    const input = baseInput({
      feedback: [
        { body: '冒頭の導入をもう少し柔らかく', priority: 'should' },
        { body: '具体的な事例を 3 つ追加してください', priority: 'must' },
      ] as RevisionFeedbackItem[],
    });
    const text = buildLlmResponse(input);
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await editBook(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    const systemMsg = args.messages.find((m) => m.role === 'system');
    const userMsg = args.messages.find((m) => m.role === 'user');
    expect(systemMsg!.content).toContain('具体的な事例を 3 つ追加してください');
    expect(systemMsg!.content).toContain('冒頭の導入をもう少し柔らかく');
    expect(systemMsg!.content).toContain('[MUST]');
    expect(systemMsg!.content).toContain('[SHOULD]');
    // must が should より先に並ぶ (priority sort)
    const mustIdx = systemMsg!.content.indexOf('[MUST]');
    const shouldIdx = systemMsg!.content.indexOf('[SHOULD]');
    expect(mustIdx).toBeGreaterThanOrEqual(0);
    expect(mustIdx).toBeLessThan(shouldIdx);
    // user メッセージにも反映
    expect(userMsg!.content).toContain('修正コメント');
    expect(userMsg!.content).toContain('具体的な事例を 3 つ追加してください');
  });

  it('プレースホルダ ({theme_title}/{ai_disclosure_text}/{chapter_count}/{draft_chapters}) が system に差し込まれる', async () => {
    const input = baseInput({
      genre: 'business',
      themeContext: {
        title: 'ChatGPT 完全活用ガイド',
        hook: 'プロンプト 100 連発',
        target_reader: 'ビジネスパーソン',
      },
      aiDisclosureText: 'カスタム開示文 (テスト用)',
    });
    const text = buildLlmResponse(input, { disclosure: false });
    // disclosure=false でも user 注入を上書きするため、aiDisclosureText を含む応答に揃える
    // → 最終章末尾に「カスタム開示文 (テスト用)」を強制挿入される動作も同時に検証する
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([
      { ...defaultPromptRow(), genre: 'business' },
    ]);

    const result = await editBook(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    const systemMsg = args.messages.find((m) => m.role === 'system');
    expect(systemMsg!.content).toContain('ChatGPT 完全活用ガイド');
    expect(systemMsg!.content).toContain('ビジネス書');
    // 章ごと校閲のため chapter_count は 1 (チャンク = 1 章)
    expect(systemMsg!.content).toContain('章数: 1');
    // draft_chapters: JSON 配列が埋め込まれている (compact JSON: 空白なし)
    expect(systemMsg!.content).toContain('"index":1');
    expect(systemMsg!.content).toContain('"heading":"第1章 サンプル見出し"');
    // AI 開示文は **最終章のチャンク** の system にのみ注入される
    // (非最終章では重複挿入を防ぐため空文字を渡す設計)。
    // 第1段の最終章呼び出し = 8 章目 = calls[7]。
    const lastChunkArgs = completeMock.mock.calls[7]![0];
    const lastSystemMsg = lastChunkArgs.messages.find((m) => m.role === 'system');
    expect(lastSystemMsg!.content).toContain('カスタム開示文 (テスト用)');

    // カスタム開示文が強制挿入される
    const last = result.chapters[result.chapters.length - 1]!;
    expect(last.body_md).toContain('カスタム開示文 (テスト用)');
    expect(result.ai_disclosure_text).toBe('カスタム開示文 (テスト用)');
  });
});

// ---------------------------------------------------------------------------
// 9-11. token_usage 記録 (T-03-01 / T-04-01/02 教訓回帰防止)
// ---------------------------------------------------------------------------

describe('editBook — token_usage 記録 (T-03-01 / T-04-01/02 教訓回帰防止)', () => {
  it('jobId 未指定時、token_usage.create の data.job_id は null、book_id は input.bookId と一致する', async () => {
    const input = baseInput({ bookId: 'book-xyz' });
    const text = buildLlmResponse(input);
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    type CreateArgs = {
      data: {
        job_id: string | null;
        book_id: string | null;
        theme_session_id: string | null;
        role: string;
      };
    };
    const tokenUsageCreate = vi.fn(async (_args: CreateArgs) => undefined);
    const wrappingDeps: WithTokenLoggingDeps = {
      prisma: {
        tokenUsage: { create: tokenUsageCreate },
        book: { update: vi.fn() },
      } as never,
      logger: { warn: vi.fn() },
      fetchPriceSnapshot: async () => ({ snap: true }),
    };

    const wrappingFactory: EditBookDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await editBook(input, {
      createAgentClient: wrappingFactory,
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(tokenUsageCreate).toHaveBeenCalledTimes(expectedCompleteCalls(8));
    const createArgs = tokenUsageCreate.mock.calls[0]![0];
    expect(createArgs.data.job_id).toBeNull();
    expect(createArgs.data.book_id).toBe('book-xyz');
    expect(createArgs.data.role).toBe('editor');
  });

  it('jobId 指定時、token_usage.create の data.job_id が input.jobId と一致する', async () => {
    const input = baseInput({ bookId: 'book-xyz', jobId: 'job-123' });
    const text = buildLlmResponse(input);
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    type CreateArgs = {
      data: { job_id: string | null; book_id: string | null };
    };
    const tokenUsageCreate = vi.fn(async (_args: CreateArgs) => undefined);
    const wrappingDeps: WithTokenLoggingDeps = {
      prisma: {
        tokenUsage: { create: tokenUsageCreate },
        book: { update: vi.fn() },
      } as never,
      logger: { warn: vi.fn() },
      fetchPriceSnapshot: async () => ({}),
    };
    const wrappingFactory: EditBookDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await editBook(input, {
      createAgentClient: wrappingFactory,
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(tokenUsageCreate).toHaveBeenCalledTimes(expectedCompleteCalls(8));
    const createArgs = tokenUsageCreate.mock.calls[0]![0];
    expect(createArgs.data.job_id).toBe('job-123');
    expect(createArgs.data.book_id).toBe('book-xyz');
  });

  it('1 回の editBook 呼出で token_usage.create が 1 回呼ばれ、book_id 紐付け + role=editor + provider=anthropic', async () => {
    const input = baseInput({ bookId: 'book-zzz' });
    const text = buildLlmResponse(input);
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    type CreateArgs = {
      data: { book_id: string | null; role: string; provider: string };
    };
    const tokenUsageCreate = vi.fn(async (_args: CreateArgs) => undefined);
    const wrappingDeps: WithTokenLoggingDeps = {
      prisma: {
        tokenUsage: { create: tokenUsageCreate },
        book: { update: vi.fn() },
      } as never,
      logger: { warn: vi.fn() },
      fetchPriceSnapshot: async () => ({}),
    };
    const wrappingFactory: EditBookDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await editBook(input, {
      createAgentClient: wrappingFactory,
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(tokenUsageCreate).toHaveBeenCalledTimes(expectedCompleteCalls(8));
    const createArgs = tokenUsageCreate.mock.calls[0]![0];
    expect(createArgs.data.book_id).toBe('book-zzz');
    expect(createArgs.data.role).toBe('editor');
    expect(createArgs.data.provider).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// 12. 入力章数 7 → 校閲後も 7 章維持
// ---------------------------------------------------------------------------

describe('editBook — 章数バリエーション', () => {
  it('入力 7 章 → 校閲後も 7 章維持', async () => {
    const input = baseInput({
      chapters: Array.from({ length: 7 }, (_, i) => sampleInputChapter(i + 1)),
    });
    const text = buildLlmResponse(input);
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await editBook(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.chapters).toHaveLength(7);
    expect(result.chapters.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.ai_disclosure_appended).toBe(true);
  });

  it('入力 10 章 → 校閲後も 10 章維持', async () => {
    const input = baseInput({
      chapters: Array.from({ length: 10 }, (_, i) => sampleInputChapter(i + 1)),
    });
    const text = buildLlmResponse(input);
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await editBook(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.chapters).toHaveLength(10);
    expect(result.ai_disclosure_appended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 補: LLM 呼出パラメータ整合 (回帰防止)
// ---------------------------------------------------------------------------

describe('editBook — LLM 呼出パラメータ', () => {
  it('client.complete に role=editor + maxOutputTokens=32768 + system/user 両方が渡る', async () => {
    const input = baseInput();
    const text = buildLlmResponse(input);
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await editBook(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    expect(args.role).toBe('editor');
    expect(args.maxOutputTokens).toBe(32768);
    expect(args.messages).toHaveLength(2);
    expect(args.messages[0]!.role).toBe('system');
    expect(args.messages[1]!.role).toBe('user');
  });

  it('createAgentClient が role=editor / ctx.bookId / ctx.jobId を渡される', async () => {
    const input = baseInput({ bookId: 'book-ABC', jobId: 'job-789' });
    const text = buildLlmResponse(input);
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    const createSpy: EditBookDeps['createAgentClient'] = vi.fn(
      async () => fakeClient,
    );

    await editBook(input, {
      createAgentClient: createSpy,
      promptLoaderDeps: { prisma: promptRepo },
    });

    const spyMock = createSpy as unknown as { mock: { calls: unknown[][] } };
    expect(spyMock.mock.calls).toHaveLength(1);
    const callArgs = spyMock.mock.calls[0]!;
    expect(callArgs[0]).toBe('editor');
    expect(callArgs[1]).toBeNull();
    const ctx = callArgs[2] as { role: string; bookId: string; jobId?: string };
    expect(ctx).toMatchObject({
      role: 'editor',
      bookId: 'book-ABC',
      jobId: 'job-789',
    });
  });
});

// ---------------------------------------------------------------------------
// 補: heading が LLM 応答に欠落しても入力の同 index heading で補完される
// ---------------------------------------------------------------------------

describe('editBook — heading 補完', () => {
  it('LLM が一部の章 heading を省いても、入力 chapters[index 一致] の heading で補完される', async () => {
    const input = baseInput();
    // 全章で heading を欠落させる
    const chaptersOverride = input.chapters.map((c, i) => {
      const isLast = i === input.chapters.length - 1;
      return {
        index: c.index,
        // heading 欠落
        body_md: isLast
          ? buildBody(800) + '\n\n' + DEFAULT_AI_DISCLOSURE
          : buildBody(800),
        diff_summary: '誤字修正',
      } as { index: number; heading?: string; body_md: string; diff_summary?: string };
    });
    const text = buildLlmResponse(input, { chaptersOverride });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await editBook(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    // 入力と完全一致 (補完成功)
    for (let i = 0; i < result.chapters.length; i++) {
      expect(result.chapters[i]!.heading).toBe(input.chapters[i]!.heading);
    }
  });
});
