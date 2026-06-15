/**
 * T-04-01 — Writer エージェント (アウトライン生成) 単体テスト。
 *
 * 戦略 (marketer/theme.test.ts と同パターン):
 *  - `createAgentClient` を vi.fn() で差し替え、LLMClient.complete を mock する
 *  - `loadActivePrompt` / `prisma.prompt.findFirst` は @a2p/db mock + promptLoaderDeps
 *    両方の経路を検証する
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
  WriterOutlineInput,
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

const { generateOutline } = await import('../../src/writer/outline.js');
import type { GenerateOutlineDeps } from '../../src/writer/outline.js';
const { withTokenLogging } = await import('../../src/lib/with-token-logging.js');
import type {
  LoggingContext,
  WithTokenLoggingDeps,
} from '../../src/lib/with-token-logging.js';

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

/**
 * 章 1 件分のサンプル。target_chars を任意指定可能 (合計値テスト用)。
 */
function sampleChapter(index: number, overrides: Partial<ChapterPlan> = {}): ChapterPlan {
  return {
    index,
    heading: overrides.heading ?? `第${index}章 見出し`,
    summary: overrides.summary ?? `第${index}章の要旨です。`,
    target_chars: overrides.target_chars ?? 6250, // 8 章で合計 50,000
    subheadings: overrides.subheadings ?? ['小見出し1', '小見出し2'],
  };
}

/**
 * count 章 + 合計 totalChars (各章 target_chars を均等分配) のアウトラインを生成。
 * 端数は最終章に寄せる。
 */
function buildChapters(count: number, totalChars: number): ChapterPlan[] {
  const base = Math.floor(totalChars / count);
  const remainder = totalChars - base * count;
  return Array.from({ length: count }, (_, i) => {
    const target = base + (i === count - 1 ? remainder : 0);
    return sampleChapter(i + 1, { target_chars: target });
  });
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
      usage: { inputTokens: 1000, outputTokens: 500 },
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
      'あなたはライターです。書籍: {title} / 副題: {subtitle} / フック: {hook} / 想定読者: {target_reader}\n' +
      'ジャンル: {genre} / 章数: {target_chapter_count} / 総文字数: {target_total_chars}\n' +
      '差戻し指示: {reject_note}\n' +
      '参考キーワード: {kdp_keywords}',
    status: 'active',
  };
}

function baseInput(overrides: Partial<WriterOutlineInput> = {}): WriterOutlineInput {
  const base: WriterOutlineInput = {
    bookId: overrides.bookId ?? 'book-1',
    accountId: overrides.accountId ?? 'acc-1',
    genre: overrides.genre ?? null,
    themeContext: overrides.themeContext ?? {
      title: '副業で月 5 万円',
      subtitle: '初心者向け実践ガイド',
      hook: '既存本にない切り口で 30 代副業初心者に最短ルートを示す',
      target_reader: '30 代会社員 / 副業初心者',
    },
    targetChapterCount: overrides.targetChapterCount ?? 8,
    targetTotalChars: overrides.targetTotalChars ?? 50000,
  };
  if (overrides.jobId !== undefined) base.jobId = overrides.jobId;
  if (overrides.rejectNote !== undefined) base.rejectNote = overrides.rejectNote;
  if (overrides.kdpMetadata !== undefined) base.kdpMetadata = overrides.kdpMetadata;
  return base;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. happy path — 8 章 / 合計 50000 字
// ---------------------------------------------------------------------------

describe('generateOutline — happy path', () => {
  it('8 章合計 50000 字のアウトラインを生成し chapters + totalCharsEstimate を返す', async () => {
    const chapters = buildChapters(8, 50000);
    const text = jsonResponse({ chapters, totalCharsEstimate: 50000, notes: 'ok' });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateOutline(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.chapters).toHaveLength(8);
    expect(result.totalCharsEstimate).toBe(50000);
    expect(result.notes).toBe('ok');
    expect(result.chapters[0]!.index).toBe(1);
    expect(result.chapters[7]!.index).toBe(8);
    expect(fakeClient.complete).toHaveBeenCalledTimes(1);
  });

  it('totalCharsEstimate を LLM が省いても chapters[].target_chars 合計で再計算され埋まる', async () => {
    const chapters = buildChapters(8, 50000);
    // totalCharsEstimate を意図的に省略
    const text = jsonResponse({ chapters });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateOutline(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.totalCharsEstimate).toBe(50000);
  });
});

// ---------------------------------------------------------------------------
// 2. 章数 6 (下限未満) → AgentError
// ---------------------------------------------------------------------------

describe('generateOutline — 章数バリデーション', () => {
  it('章数 6 (下限 7 未満) → AgentError(invalid_output)', async () => {
    const chapters = buildChapters(6, 50000);
    const text = jsonResponse({ chapters, totalCharsEstimate: 50000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateOutline(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
  });

  // ---------------------------------------------------------------------------
  // 3. 章数 11 (上限超) → AgentError
  // ---------------------------------------------------------------------------

  it('章数 11 (上限 10 超) → AgentError(invalid_output)', async () => {
    const chapters = buildChapters(11, 50000);
    const text = jsonResponse({ chapters, totalCharsEstimate: 50000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await expect(
      generateOutline(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });
});

// ---------------------------------------------------------------------------
// 4 / 5. 文字数合計範囲外 → AgentError(chars_out_of_range)
// ---------------------------------------------------------------------------

describe('generateOutline — 文字数合計レンジ検証', () => {
  it('合計 30000 字 (下限 42500 未満) → AgentError(chars_out_of_range)', async () => {
    // 8 章で合計 30000 (各章 3750)
    const chapters = buildChapters(8, 30000);
    const text = jsonResponse({ chapters, totalCharsEstimate: 30000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateOutline(baseInput({ targetTotalChars: 50000 }), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/chars_out_of_range/);
    const details = (caught as AgentError).details as {
      total: number; expected_min: number; expected_max: number;
    };
    expect(details.total).toBe(30000);
    expect(details.expected_min).toBe(42500);
    expect(details.expected_max).toBe(57500);
  });

  it('合計 70000 字 (上限 57500 超) → AgentError(chars_out_of_range)', async () => {
    // 8 章で合計 70000 (各章 8750)
    const chapters = buildChapters(8, 70000);
    const text = jsonResponse({ chapters, totalCharsEstimate: 70000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateOutline(baseInput({ targetTotalChars: 50000 }), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/chars_out_of_range/);
  });

  it('境界値: 合計 42500 字 (= ±15% 下限丁度) は PASS', async () => {
    const chapters = buildChapters(8, 42500);
    const text = jsonResponse({ chapters, totalCharsEstimate: 42500 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateOutline(
      baseInput({ targetTotalChars: 50000 }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );
    expect(result.chapters).toHaveLength(8);
    expect(result.totalCharsEstimate).toBe(42500);
  });
});

// ---------------------------------------------------------------------------
// 6. index 不連続 (1, 2, 4) → AgentError(idx_not_sequential)
// ---------------------------------------------------------------------------

describe('generateOutline — index 連番性検証', () => {
  it('index が (1, 2, 4, 5, 6, 7, 8, 9) で 3 が欠落 → AgentError(idx_not_sequential)', async () => {
    const base = buildChapters(8, 50000);
    // index を 1,2,4,5,6,7,8,9 に書き換え
    const broken = base.map((c, i) => ({ ...c, index: i < 2 ? i + 1 : i + 2 }));
    const text = jsonResponse({ chapters: broken, totalCharsEstimate: 50000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateOutline(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/idx_not_sequential/);
  });
});

// ---------------------------------------------------------------------------
// 7. JSON parse 失敗 → AgentError(invalid_output)
// ---------------------------------------------------------------------------

describe('generateOutline — 出力検証', () => {
  it('JSON ではないテキスト → AgentError(invalid_output)', async () => {
    const fakeClient = makeFakeClient('I am not JSON at all, sorry.');
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateOutline(baseInput(), {
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
      generateOutline(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });
});

// ---------------------------------------------------------------------------
// 8. rejectNote 指定時 → prompt に注入される
// ---------------------------------------------------------------------------

describe('generateOutline — プロンプト差込', () => {
  it('rejectNote 指定時、system プロンプト + user メッセージに反映される', async () => {
    const chapters = buildChapters(8, 50000);
    const text = jsonResponse({ chapters, totalCharsEstimate: 50000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await generateOutline(
      baseInput({ rejectNote: '第3章をもっと具体的な事例にしてほしい' }),
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
    expect(systemMsg).toBeDefined();
    // system プロンプトテンプレ内の {reject_note} に注入される
    expect(systemMsg!.content).toContain('第3章をもっと具体的な事例にしてほしい');
    // user メッセージにも「前回アウトラインの差戻し指示」として明示される
    const userMsg = args.messages.find((m) => m.role === 'user');
    expect(userMsg!.content).toContain('差戻し指示');
    expect(userMsg!.content).toContain('第3章をもっと具体的な事例にしてほしい');
  });

  it('プレースホルダ ({title}/{target_chapter_count}/{target_total_chars}/{genre}) が system に差し込まれる', async () => {
    const chapters = buildChapters(8, 50000);
    const text = jsonResponse({ chapters, totalCharsEstimate: 50000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([
      { ...defaultPromptRow(), genre: 'business' },
    ]);

    await generateOutline(
      baseInput({
        genre: 'business',
        themeContext: {
          title: 'ChatGPT 完全活用ガイド',
          hook: 'プロンプト 100 連発',
          target_reader: 'ビジネスパーソン',
        },
        targetChapterCount: 9,
        targetTotalChars: 48000,
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
    expect(systemMsg!.content).toContain('9');
    expect(systemMsg!.content).toContain('48000');
  });
});

// ---------------------------------------------------------------------------
// 9. jobId 未指定 → ctx.jobId = undefined → token_usage.job_id = null
// ---------------------------------------------------------------------------

describe('generateOutline — token_usage 記録 (T-03-01 教訓回帰防止)', () => {
  it('jobId 未指定時、token_usage.create の data.job_id は null、book_id は input.bookId と一致する', async () => {
    const chapters = buildChapters(8, 50000);
    const text = jsonResponse({ chapters, totalCharsEstimate: 50000 });
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

    const wrappingFactory: GenerateOutlineDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await generateOutline(
      // jobId 未指定 — UI 直接呼出相当 (T-03-01 教訓: ctx.jobId を含めず null forward)
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
  // 10. jobId 指定 → ctx.jobId 経由で forward
  // -------------------------------------------------------------------------

  it('jobId 指定時、token_usage.create の data.job_id が input.jobId と一致する', async () => {
    const chapters = buildChapters(8, 50000);
    const text = jsonResponse({ chapters, totalCharsEstimate: 50000 });
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
    const wrappingFactory: GenerateOutlineDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await generateOutline(
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
  // 11. token_usage 1 行 INSERT (book_id 紐付け、role='writer')
  // -------------------------------------------------------------------------

  it('1 回の generateOutline 呼出で token_usage.create が 1 回呼ばれ、book_id 紐付け + role=writer', async () => {
    const chapters = buildChapters(8, 50000);
    const text = jsonResponse({ chapters, totalCharsEstimate: 50000 });
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
    const wrappingFactory: GenerateOutlineDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await generateOutline(
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

describe('generateOutline — LLM 呼出パラメータ', () => {
  it('client.complete に role=writer + maxOutputTokens=8192 + system/user 両方が渡る', async () => {
    const chapters = buildChapters(8, 50000);
    const text = jsonResponse({ chapters, totalCharsEstimate: 50000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await generateOutline(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    expect(args.role).toBe('writer');
    expect(args.maxOutputTokens).toBe(8192);
    expect(args.messages).toHaveLength(2);
    expect(args.messages[0]!.role).toBe('system');
    expect(args.messages[1]!.role).toBe('user');
  });

  it('createAgentClient が role=writer / ctx.bookId / ctx.jobId を渡される', async () => {
    const chapters = buildChapters(8, 50000);
    const text = jsonResponse({ chapters, totalCharsEstimate: 50000 });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    const createSpy: GenerateOutlineDeps['createAgentClient'] = vi.fn(
      async () => fakeClient,
    );

    await generateOutline(
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
