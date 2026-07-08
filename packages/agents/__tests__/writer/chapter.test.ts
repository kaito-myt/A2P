/**
 * T-04-02 — Writer エージェント (章執筆) 単体テスト。
 *
 * 戦略 (writer/outline.test.ts と同パターン):
 *  - `createAgentClient` を vi.fn() で差し替え、LLMClient.complete を mock する
 *  - `loadActivePrompt` は promptLoaderDeps 経由で repo を差し替える
 *  - token_usage 記録は withTokenLoggingDeps の prisma 経由で create 呼出回数を確認
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
  ChapterPlan,
  RevisionFeedbackItem,
  WriterChapterInput,
} from '@a2p/contracts/agents/writer';

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

const { generateChapter } = await import('../../src/writer/chapter.js');
import type { GenerateChapterDeps } from '../../src/writer/chapter.js';
const { withTokenLogging } = await import('../../src/lib/with-token-logging.js');
import type {
  LoggingContext,
  WithTokenLoggingDeps,
} from '../../src/lib/with-token-logging.js';

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

function sampleOutlineChapter(overrides: Partial<ChapterPlan> = {}): ChapterPlan {
  return {
    index: overrides.index ?? 1,
    heading: overrides.heading ?? '第1章 副業の選び方',
    summary: overrides.summary ?? '副業の選定基準を解説する章。',
    target_chars: overrides.target_chars ?? 8000,
    subheadings: overrides.subheadings ?? [
      '副業の種類と特徴',
      '時間と収入のバランス',
      '初心者向けの始め方',
    ],
  };
}

/**
 * 指定文字数 (codepoint 数) の Markdown 本文を生成する。
 * テスト用なので意味のある本文ではなく、`## 見出し\n本文...` の繰り返し。
 * 文字数は `[...str].length` ベースで保証する。
 */
function buildBody(chars: number): string {
  const prefix = '## 小見出し\n\n';
  const filler = 'あ';
  const repeatNeeded = Math.max(0, chars - [...prefix].length);
  return prefix + filler.repeat(repeatNeeded);
}

function jsonResponse(payload: unknown): string {
  return JSON.stringify(payload);
}

function makeFakeClient(text: string): LLMClient {
  const completeImpl = async <T = string>(
    _args: LLMCompleteArgs,
  ): Promise<LLMCompleteResult<T>> => {
    return {
      text: text as T,
      usage: { inputTokens: 2000, outputTokens: 8000 },
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
    id: 'p-writer-1',
    role: 'writer',
    genre: null,
    version: 1,
    body:
      'あなたはライターです。書籍: {theme_title} / 副題: {theme_subtitle} / フック: {theme_hook} / 想定読者: {target_reader}\n' +
      'ジャンル: {genre}\n' +
      '章: 第{chapter_index}章 {chapter_heading}\n' +
      '要旨: {chapter_summary}\n' +
      '小見出し: {chapter_subheadings}\n' +
      '目標文字数: {target_chars}\n' +
      '直前章まで: {previous_chapters_summary}\n' +
      '修正コメント: {feedback}',
    status: 'active',
  };
}

function baseInput(overrides: Partial<WriterChapterInput> = {}): WriterChapterInput {
  const base: WriterChapterInput = {
    bookId: overrides.bookId ?? 'book-1',
    accountId: overrides.accountId ?? 'acc-1',
    genre: overrides.genre ?? null,
    outlineChapter: overrides.outlineChapter ?? sampleOutlineChapter(),
    themeContext: overrides.themeContext ?? {
      title: '副業で月 5 万円',
      subtitle: '初心者向け実践ガイド',
      hook: '既存本にない切り口で 30 代副業初心者に最短ルートを示す',
      target_reader: '30 代会社員 / 副業初心者',
    },
  };
  if (overrides.jobId !== undefined) base.jobId = overrides.jobId;
  if (overrides.previousChaptersSummary !== undefined) {
    base.previousChaptersSummary = overrides.previousChaptersSummary;
  }
  if (overrides.feedback !== undefined) base.feedback = overrides.feedback;
  return base;
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

describe('generateChapter — happy path', () => {
  it('target 8000 字 / actual 8000 字で成功し、heading/body_md/char_count を返す', async () => {
    const body = buildBody(8000);
    const text = jsonResponse({
      heading: '第1章 副業の選び方',
      body_md: body,
      char_count: 8000,
    });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateChapter(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.heading).toBe('第1章 副業の選び方');
    expect(result.body_md).toBe(body);
    // char_count は呼出側で再計算され、LLM 申告値ではなく実 codepoint 数になる
    expect(result.char_count).toBe([...body].length);
    expect(fakeClient.complete).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 2. 文字数下限未満 → AgentError
// ---------------------------------------------------------------------------

describe('generateChapter — 文字数レンジ検証', () => {
  it('target 8000 / actual 5000 字 (下限 5200 未満) → AgentError(chars_out_of_range)', async () => {
    const body = buildBody(5000);
    const text = jsonResponse({ heading: '第1章', body_md: body, char_count: 5000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateChapter(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/chars_out_of_range/);
    const details = (caught as AgentError).details as {
      actual: number; expected_min: number; expected_max: number; target: number;
    };
    expect(details.actual).toBe(5000);
    // ±35%: 8000 × 0.65 = 5200, 8000 × 1.35 = 10800
    expect(details.expected_min).toBe(5200);
    expect(details.expected_max).toBe(10800);
    expect(details.target).toBe(8000);
  });

  // -------------------------------------------------------------------------
  // 3. 文字数上限超 → AgentError
  // -------------------------------------------------------------------------

  it('target 8000 / actual 11000 字 (上限 10800 超) → AgentError(chars_out_of_range)', async () => {
    const body = buildBody(11000);
    const text = jsonResponse({ heading: '第1章', body_md: body, char_count: 11000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await expect(
      generateChapter(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  // -------------------------------------------------------------------------
  // 4. 境界値: target 8000 / actual 6400 (= 8000*0.80) は PASS
  // -------------------------------------------------------------------------

  it('境界値: target 8000 / actual 6400 字 (= ±20% 下限丁度、target 8000 × 0.80) は PASS', async () => {
    const body = buildBody(6400);
    const text = jsonResponse({ heading: '第1章', body_md: body, char_count: 6400 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateChapter(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });
    expect(result.char_count).toBe(6400);
  });

  // -------------------------------------------------------------------------
  // 5. 境界値: target 8000 / actual 9600 (= 8000*1.20) は PASS
  // -------------------------------------------------------------------------

  it('境界値: target 8000 / actual 9600 字 (= ±20% 上限丁度、target 8000 × 1.20) は PASS', async () => {
    const body = buildBody(9600);
    const text = jsonResponse({ heading: '第1章', body_md: body, char_count: 9600 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateChapter(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });
    expect(result.char_count).toBe(9600);
  });

  // -------------------------------------------------------------------------
  // 補: 絵文字 (surrogate pair) は 1 文字としてカウントされる
  // -------------------------------------------------------------------------

  it('絵文字 (surrogate pair) は 1 文字としてカウントされ、string.length ではなく codepoint 数で判定する', async () => {
    // 7000 字 + 🎉 1 字 = 7001 codepoint。string.length では 7002 になるが [...str].length は 7001。
    // target 8000 (±20% 下限 6400) 内なので PASS。
    const body = buildBody(7000) + '🎉';
    expect(body.length).toBe(7002); // string.length (surrogate pair で 2)
    expect([...body].length).toBe(7001); // codepoint 数
    const text = jsonResponse({ heading: '第1章', body_md: body, char_count: 7001 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateChapter(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });
    expect(result.char_count).toBe(7001);
  });
});

// ---------------------------------------------------------------------------
// SP-04 §4 T-04-02 完了判定 (docs/sprints/SP-04-*.md line 57):
//   「5000 字想定で 4000〜6000 字が返るテスト PASS」
// target 5000 × ±20% = 4000〜6000 を 4 ケース (PASS 下限 / PASS 上限 / FAIL 下限-1 / FAIL 上限+1)
// でコード化し、完了判定文と test を直結させて回帰防止する。
// ---------------------------------------------------------------------------

describe('generateChapter — SP-04 §4 T-04-02 完了判定 (target 5000 字 / ±20% = 4000〜6000)', () => {
  async function runWithActual(actualChars: number) {
    const body = buildBody(actualChars);
    const text = jsonResponse({ heading: '第1章', body_md: body, char_count: actualChars });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    return generateChapter(
      baseInput({ outlineChapter: sampleOutlineChapter({ target_chars: 5000 }) }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );
  }

  it('target 5000 / actual 4000 字 (下限丁度) → PASS', async () => {
    const result = await runWithActual(4000);
    expect(result.char_count).toBe(4000);
  });

  it('target 5000 / actual 6000 字 (上限丁度) → PASS', async () => {
    const result = await runWithActual(6000);
    expect(result.char_count).toBe(6000);
  });

  it('target 5000 / actual 3200 字 (下限 3250 未満) → AgentError(chars_out_of_range)', async () => {
    let caught: unknown;
    try {
      await runWithActual(3200);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/chars_out_of_range/);
    const details = (caught as AgentError).details as {
      actual: number; expected_min: number; expected_max: number; target: number;
    };
    expect(details.actual).toBe(3200);
    // ±35%: 5000 × 0.65 = 3250, 5000 × 1.35 = 6750
    expect(details.expected_min).toBe(3250);
    expect(details.expected_max).toBe(6750);
    expect(details.target).toBe(5000);
  });

  it('target 5000 / actual 7000 字 (上限 6750 超) → AgentError(chars_out_of_range)', async () => {
    let caught: unknown;
    try {
      await runWithActual(7000);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/chars_out_of_range/);
    const details = (caught as AgentError).details as {
      actual: number; expected_min: number; expected_max: number;
    };
    expect(details.actual).toBe(7000);
    expect(details.expected_min).toBe(3250);
    expect(details.expected_max).toBe(6750);
  });
});

// ---------------------------------------------------------------------------
// 6. JSON parse 失敗 → AgentError
// ---------------------------------------------------------------------------

describe('generateChapter — 出力検証', () => {
  it('JSON ではないテキスト → AgentError(invalid_output)', async () => {
    const fakeClient = makeFakeClient('I am not JSON at all, sorry.');
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateChapter(baseInput(), {
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
    const fakeClient = makeFakeClient('   ');
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await expect(
      generateChapter(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  // -------------------------------------------------------------------------
  // 7. zod 検証失敗 (body_md 短すぎ) → AgentError
  // -------------------------------------------------------------------------

  it('body_md が 500 字未満 → AgentError(invalid_output: schema validation failed)', async () => {
    const text = jsonResponse({
      heading: '第1章',
      body_md: 'too short',
      char_count: 9,
    });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateChapter(baseInput(), {
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
});

// ---------------------------------------------------------------------------
// 8. feedback 指定時 → prompt に注入される (system + user 両方)
// ---------------------------------------------------------------------------

describe('generateChapter — プロンプト差込', () => {
  it('feedback (must/should) 指定時、system プロンプト + user メッセージに反映される', async () => {
    const body = buildBody(8000);
    const text = jsonResponse({ heading: '第1章', body_md: body, char_count: 8000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const feedback: RevisionFeedbackItem[] = [
      { body: '具体的な事例を 3 つ追加してください', priority: 'must' },
      { body: '冒頭の導入をもう少し柔らかく', priority: 'should' },
    ];

    await generateChapter(
      baseInput({ feedback }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    const systemMsg = args.messages.find((m) => m.role === 'system');
    const userMsg = args.messages.find((m) => m.role === 'user');
    expect(systemMsg).toBeDefined();
    expect(userMsg).toBeDefined();
    // system プロンプトの {feedback} に反映 (priority 順 must → should)
    expect(systemMsg!.content).toContain('具体的な事例を 3 つ追加してください');
    expect(systemMsg!.content).toContain('冒頭の導入をもう少し柔らかく');
    expect(systemMsg!.content).toContain('[MUST]');
    expect(systemMsg!.content).toContain('[SHOULD]');
    // must が should より前に並んでいる (priority sort)
    const mustIdx = systemMsg!.content.indexOf('[MUST]');
    const shouldIdx = systemMsg!.content.indexOf('[SHOULD]');
    expect(mustIdx).toBeLessThan(shouldIdx);
    // user メッセージにも「修正コメント」セクションが含まれる
    expect(userMsg!.content).toContain('修正コメント');
    expect(userMsg!.content).toContain('具体的な事例を 3 つ追加してください');
  });

  // -------------------------------------------------------------------------
  // 9. previousChaptersSummary 指定時 → prompt に注入される
  // -------------------------------------------------------------------------

  it('previousChaptersSummary 指定時、system + user に注入され文体一貫性を促す', async () => {
    const body = buildBody(8000);
    const text = jsonResponse({ heading: '第2章', body_md: body, char_count: 8000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await generateChapter(
      baseInput({
        outlineChapter: sampleOutlineChapter({ index: 2, heading: '第2章 副業の始め方' }),
        previousChaptersSummary:
          '第1章では副業の選び方を解説。読者の時間制約と収入目標から逆算する手法を提示した。',
      }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    const systemMsg = args.messages.find((m) => m.role === 'system');
    const userMsg = args.messages.find((m) => m.role === 'user');
    expect(systemMsg!.content).toContain('第1章では副業の選び方を解説');
    expect(userMsg!.content).toContain('直前章までの要約');
    expect(userMsg!.content).toContain('第1章では副業の選び方を解説');
  });

  it('プレースホルダ ({chapter_index}/{chapter_heading}/{target_chars}/{theme_title}) が system に差し込まれる', async () => {
    const body = buildBody(7500);
    const text = jsonResponse({ heading: '第3章', body_md: body, char_count: 7500 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([
      { ...defaultPromptRow(), genre: 'business' },
    ]);

    await generateChapter(
      baseInput({
        genre: 'business',
        outlineChapter: sampleOutlineChapter({
          index: 3,
          heading: '第3章 案件獲得の戦略',
          target_chars: 7500,
        }),
        themeContext: {
          title: 'ChatGPT 完全活用ガイド',
          hook: 'プロンプト 100 連発',
          target_reader: 'ビジネスパーソン',
        },
      }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    const systemMsg = args.messages.find((m) => m.role === 'system');
    expect(systemMsg!.content).toContain('ChatGPT 完全活用ガイド');
    expect(systemMsg!.content).toContain('business');
    expect(systemMsg!.content).toContain('第3章 案件獲得の戦略');
    expect(systemMsg!.content).toContain('7500');
  });
});

// ---------------------------------------------------------------------------
// 10. jobId 未指定 → ctx.jobId = undefined → token_usage.job_id = null
//     (T-03-01 教訓: FK 違反回避の回帰防止)
// ---------------------------------------------------------------------------

describe('generateChapter — token_usage 記録 (T-03-01 教訓回帰防止)', () => {
  it('jobId 未指定時、token_usage.create の data.job_id は null、book_id は input.bookId と一致する', async () => {
    const body = buildBody(8000);
    const text = jsonResponse({ heading: '第1章', body_md: body, char_count: 8000 });
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

    const wrappingFactory: GenerateChapterDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await generateChapter(
      // jobId 未指定 — UI 直接呼出相当
      baseInput({ bookId: 'book-xyz' }),
      {
        createAgentClient: wrappingFactory,
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(tokenUsageCreate).toHaveBeenCalledTimes(1);
    const createArgs = tokenUsageCreate.mock.calls[0]![0];
    expect(createArgs.data.job_id).toBeNull();
    expect(createArgs.data.book_id).toBe('book-xyz');
    expect(createArgs.data.role).toBe('writer');
  });

  // -------------------------------------------------------------------------
  // 11. jobId 指定 → ctx.jobId 経由で forward
  // -------------------------------------------------------------------------

  it('jobId 指定時、token_usage.create の data.job_id が input.jobId と一致する', async () => {
    const body = buildBody(8000);
    const text = jsonResponse({ heading: '第1章', body_md: body, char_count: 8000 });
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
    const wrappingFactory: GenerateChapterDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await generateChapter(
      baseInput({ bookId: 'book-xyz', jobId: 'job-123' }),
      {
        createAgentClient: wrappingFactory,
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(tokenUsageCreate).toHaveBeenCalledTimes(1);
    const createArgs = tokenUsageCreate.mock.calls[0]![0];
    expect(createArgs.data.job_id).toBe('job-123');
    expect(createArgs.data.book_id).toBe('book-xyz');
  });

  // -------------------------------------------------------------------------
  // 12. token_usage 1 行 INSERT (book_id 紐付け、role='writer', provider='anthropic')
  // -------------------------------------------------------------------------

  it('1 回の generateChapter 呼出で token_usage.create が 1 回呼ばれ、book_id 紐付け + role=writer', async () => {
    const body = buildBody(8000);
    const text = jsonResponse({ heading: '第1章', body_md: body, char_count: 8000 });
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
    const wrappingFactory: GenerateChapterDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await generateChapter(
      baseInput({ bookId: 'book-zzz' }),
      {
        createAgentClient: wrappingFactory,
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(tokenUsageCreate).toHaveBeenCalledTimes(1);
    const createArgs = tokenUsageCreate.mock.calls[0]![0];
    expect(createArgs.data.book_id).toBe('book-zzz');
    expect(createArgs.data.role).toBe('writer');
    expect(createArgs.data.provider).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// 補: LLM 呼出パラメータ整合 (回帰防止)
// ---------------------------------------------------------------------------

describe('generateChapter — LLM 呼出パラメータ', () => {
  it('client.complete に role=writer + maxOutputTokens=16384 + system/user 両方が渡る', async () => {
    const body = buildBody(8000);
    const text = jsonResponse({ heading: '第1章', body_md: body, char_count: 8000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await generateChapter(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    expect(args.role).toBe('writer');
    expect(args.maxOutputTokens).toBe(16384);
    expect(args.messages).toHaveLength(2);
    expect(args.messages[0]!.role).toBe('system');
    expect(args.messages[1]!.role).toBe('user');
  });

  it('createAgentClient が role=writer / ctx.bookId / ctx.jobId を渡される', async () => {
    const body = buildBody(8000);
    const text = jsonResponse({ heading: '第1章', body_md: body, char_count: 8000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    const createSpy: GenerateChapterDeps['createAgentClient'] = vi.fn(
      async () => fakeClient,
    );

    await generateChapter(
      baseInput({ bookId: 'book-ABC', jobId: 'job-789' }),
      {
        createAgentClient: createSpy,
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    const spyMock = createSpy as unknown as {
      mock: { calls: unknown[][] };
    };
    expect(spyMock.mock.calls).toHaveLength(1);
    const callArgs = spyMock.mock.calls[0]!;
    expect(callArgs[0]).toBe('writer');
    expect(callArgs[1]).toBeNull();
    const ctx = callArgs[2] as { role: string; bookId: string; jobId?: string };
    expect(ctx).toMatchObject({
      role: 'writer',
      bookId: 'book-ABC',
      jobId: 'job-789',
    });
  });
});

// ---------------------------------------------------------------------------
// 補: heading が LLM 応答にない場合 outlineChapter.heading で補完
// ---------------------------------------------------------------------------

describe('generateChapter — heading 補完', () => {
  it('LLM が heading を省いた場合、outlineChapter.heading で補完される', async () => {
    const body = buildBody(8000);
    // heading 欠落
    const text = jsonResponse({ body_md: body, char_count: 8000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateChapter(
      baseInput({
        outlineChapter: sampleOutlineChapter({ heading: '第1章 副業の選び方' }),
      }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );
    expect(result.heading).toBe('第1章 副業の選び方');
  });

  it('LLM が char_count を省いた場合、body_md の codepoint 数で補完され、最終 char_count は再計算値', async () => {
    const body = buildBody(8000);
    // char_count 欠落
    const text = jsonResponse({ heading: '第1章', body_md: body });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateChapter(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });
    expect(result.char_count).toBe([...body].length);
  });
});
