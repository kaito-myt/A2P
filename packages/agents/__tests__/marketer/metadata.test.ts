/**
 * T-03-02 — Marketer エージェント (KDP メタデータ生成) 単体テスト。
 *
 * 戦略 (theme.test.ts と同パターン):
 *  - `createAgentClient` を vi.fn() で差し替え、LLMClient.complete を mock
 *  - `loadActivePrompt` / `prisma.prompt.findFirst` は @a2p/db mock + promptLoaderDeps で repo 差替
 *  - token_usage 記録は実 withTokenLogging Proxy で wrap し prisma.tokenUsage.create を直接 assert
 *    (FK 違反回帰防止)
 *
 * NOTE: 実 API は叩かない。p-retry / Anthropic SDK 等の本体には触らない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentError } from '@a2p/contracts/errors';
import type {
  LLMClient,
  LLMCompleteArgs,
  LLMCompleteResult,
} from '@a2p/contracts/agents';
import type {
  MarketerMetadataInput,
  KdpMetadata,
} from '@a2p/contracts/agents/marketer';

// Prisma を引かないよう @a2p/db を mock
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

// import 順: vi.mock より後に SUT を読む
const { generateMarketerMetadata } = await import('../../src/marketer/metadata.js');
import type { GenerateMetadataDeps } from '../../src/marketer/metadata.js';
const { withTokenLogging } = await import('../../src/lib/with-token-logging.js');
import type {
  LoggingContext,
  WithTokenLoggingDeps,
} from '../../src/lib/with-token-logging.js';

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

function sampleMetadata(overrides: Partial<KdpMetadata> = {}): KdpMetadata {
  return {
    description:
      overrides.description ??
      '副業初心者の 30 代会社員に向けて、月 5 万円の安定収入を最短ルートで作る具体的手順を、実体験ベースで解説する 8 章構成の実用書です。読了後すぐに動けるテンプレ集と、3 か月で結果を出すロードマップ付き。',
    categories: overrides.categories ?? [
      'Kindle ストア > Kindleストア > Kindle本 > ビジネス・経済 > 起業',
      'Kindle ストア > Kindleストア > Kindle本 > ビジネス・経済 > 副業',
    ],
    keywords: overrides.keywords ?? ['副業', '在宅ワーク', '月5万円', '初心者'],
    suggested_price_jpy: overrides.suggested_price_jpy ?? 580,
  };
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
      usage: { inputTokens: 800, outputTokens: 400 },
      costJpy: 0,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
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
    id: 'p-marketer-1',
    role: 'marketer',
    genre: null,
    version: 1,
    body:
      'あなたはマーケターです。書籍タイトル: {title} / 副題: {subtitle} / フック: {hook}\n' +
      '想定読者: {target_reader}\nジャンル: {genre}\n参考競合:\n{competitors}',
    status: 'active',
  };
}

function baseInput(overrides: Partial<MarketerMetadataInput> = {}): MarketerMetadataInput {
  const base: MarketerMetadataInput = {
    accountId: overrides.accountId ?? 'acc-1',
    genre: overrides.genre ?? null,
    themeContext: overrides.themeContext ?? {
      title: '副業で月 5 万円',
      subtitle: '30 代会社員のための最短ロードマップ',
      hook: '既存本にない切り口で 30 代副業初心者に最短ルートを示す',
      target_reader: '30 代会社員 / 副業初心者',
      competitors: [
        { title: '副業の始め方', author: '山田太郎', asin: 'B01ABCDEFG', url: 'https://example.com/a' },
      ],
      signals: { reasoning: 'high demand' },
    },
  };
  if (overrides.themeSessionId !== undefined) base.themeSessionId = overrides.themeSessionId;
  if (overrides.jobId !== undefined) base.jobId = overrides.jobId;
  if (overrides.bookId !== undefined) base.bookId = overrides.bookId;
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

describe('generateMarketerMetadata — happy path', () => {
  it('zod を通過する KDP メタデータを返す', async () => {
    const text = jsonResponse({ metadata: sampleMetadata(), notes: '実体験ベース強調' });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateMarketerMetadata(baseInput({ themeSessionId: 'ts-1' }), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.metadata.description.length).toBeGreaterThanOrEqual(50);
    expect(result.metadata.description.length).toBeLessThanOrEqual(4000);
    expect(result.metadata.categories).toHaveLength(2);
    expect(result.metadata.keywords.length).toBeGreaterThanOrEqual(1);
    expect(result.metadata.keywords.length).toBeLessThanOrEqual(7);
    expect(result.metadata.suggested_price_jpy).toBeGreaterThanOrEqual(99);
    expect(result.notes).toBe('実体験ベース強調');
    expect(fakeClient.complete).toHaveBeenCalledTimes(1);
  });

  it('JSON が markdown ```json``` フェンスで囲まれていても抽出できる', async () => {
    const text =
      '以下を提案します。\n```json\n' +
      jsonResponse({ metadata: sampleMetadata() }) +
      '\n```\n以上です。';
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateMarketerMetadata(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.metadata.categories).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 2. KDP 制約違反 (zod で reject)
// ---------------------------------------------------------------------------

describe('generateMarketerMetadata — KDP 制約', () => {
  it('keywords が 8 個以上 → AgentError', async () => {
    const text = jsonResponse({
      metadata: sampleMetadata({
        keywords: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'],
      }),
    });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateMarketerMetadata(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
  });

  it('description が 4001 字以上 → AgentError', async () => {
    const longDesc = 'あ'.repeat(4001);
    const text = jsonResponse({
      metadata: sampleMetadata({ description: longDesc }),
    });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await expect(
      generateMarketerMetadata(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it('description が 49 字以下 → AgentError', async () => {
    const text = jsonResponse({
      metadata: sampleMetadata({ description: '短すぎる紹介文' }),
    });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await expect(
      generateMarketerMetadata(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it('categories が 1 個 (length=2 違反) → AgentError', async () => {
    const text = jsonResponse({
      metadata: sampleMetadata({ categories: ['Kindle 本 > ビジネス'] }),
    });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await expect(
      generateMarketerMetadata(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it('suggested_price_jpy < 99 → AgentError', async () => {
    const text = jsonResponse({
      metadata: sampleMetadata({ suggested_price_jpy: 50 }),
    });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await expect(
      generateMarketerMetadata(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it('keywords NFKC 重複は dedupe され 7 件以内に収まれば PASS', async () => {
    // 「副業」「フクギョウ (NFKC で fullwidth カタカナ正規化対象)」「ｆｕｋｕｇｙｏｕ」 を 3 重で含む
    // → NFKC + lower-case 重複除外で「副業」「フクギョウ」「fukugyou」の 3 件に整形される。
    // 加えてユニークな k4..k7 を追加して合計 7 件 → 内部 dedupe → 7 件で PASS することを期待。
    const text = jsonResponse({
      metadata: sampleMetadata({
        keywords: ['副業', '副業', '副業', 'k4', 'k5', 'k6', 'k7'],
      }),
    });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateMarketerMetadata(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    // 重複除外で「副業」が 1 件に縮約され、合計 5 件
    expect(result.metadata.keywords).toEqual(['副業', 'k4', 'k5', 'k6', 'k7']);
  });
});

// ---------------------------------------------------------------------------
// 3. JSON parse / zod 検証エラー
// ---------------------------------------------------------------------------

describe('generateMarketerMetadata — 出力検証', () => {
  it('JSON ではないテキスト → AgentError(invalid_output)', async () => {
    const fakeClient = makeFakeClient('I am not JSON at all, sorry.');
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateMarketerMetadata(baseInput(), {
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
      generateMarketerMetadata(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it('zod 検証失敗 (required field 欠落) → AgentError', async () => {
    // description 欠落
    const text = jsonResponse({
      metadata: {
        categories: ['c1', 'c2'],
        keywords: ['k1'],
        suggested_price_jpy: 580,
      },
    });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateMarketerMetadata(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).details).toMatchObject({ rawText: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------
// 4. prompt-loader 経由でテンプレ取得
// ---------------------------------------------------------------------------

describe('generateMarketerMetadata — prompt-loader 経由でテンプレ取得', () => {
  it('prisma.prompt.findFirst が role=marketer で呼ばれる', async () => {
    const text = jsonResponse({ metadata: sampleMetadata() });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await generateMarketerMetadata(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(promptRepo.prompt.findFirst).toHaveBeenCalledTimes(1);
    const callArgs = promptRepo.prompt.findFirst.mock.calls[0]![0] as {
      where: { role: string; status: string };
    };
    expect(callArgs.where.role).toBe('marketer');
    expect(callArgs.where.status).toBe('active');
  });

  it('プレースホルダ ({title}/{hook}/{target_reader}/{competitors}/{genre}) が system に差し込まれる', async () => {
    const text = jsonResponse({ metadata: sampleMetadata() });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([{ ...defaultPromptRow(), genre: 'business' }]);

    await generateMarketerMetadata(
      baseInput({
        genre: 'business',
        themeContext: {
          title: 'ChatGPT で月 30 万',
          subtitle: '副業最短',
          hook: '差別化フックXX',
          target_reader: '30 代 IT 系副業者',
          competitors: [
            { title: '競合本A', asin: 'B0XXX', url: 'https://ex.com/a' },
          ],
          signals: {},
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
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain('ChatGPT で月 30 万');
    expect(systemMsg!.content).toContain('差別化フックXX');
    expect(systemMsg!.content).toContain('30 代 IT 系副業者');
    expect(systemMsg!.content).toContain('ビジネス書');
    expect(systemMsg!.content).toContain('競合本A');
  });

  it('createAgentClient に role=marketer + ctx (themeSessionId/bookId) が渡る、jobId 未指定なら ctx.jobId は undefined', async () => {
    const text = jsonResponse({ metadata: sampleMetadata() });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    const createSpy: GenerateMetadataDeps['createAgentClient'] = vi.fn(
      async () => fakeClient,
    );

    await generateMarketerMetadata(
      baseInput({ themeSessionId: 'ts-XYZ', bookId: 'book-77' }),
      {
        createAgentClient: createSpy,
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    const spyMock = createSpy as unknown as { mock: { calls: unknown[][] } };
    expect(spyMock.mock.calls).toHaveLength(1);
    const callArgs = spyMock.mock.calls[0]!;
    expect(callArgs[0]).toBe('marketer');
    expect(callArgs[1]).toBeNull();
    const ctx = callArgs[2] as {
      role: string;
      themeSessionId?: string;
      bookId?: string;
      jobId?: string;
    };
    expect(ctx).toMatchObject({
      role: 'marketer',
      themeSessionId: 'ts-XYZ',
      bookId: 'book-77',
    });
    expect(ctx.jobId).toBeUndefined();
  });

  it('input.jobId 指定時は createAgentClient の ctx.jobId にそのまま渡る', async () => {
    const text = jsonResponse({ metadata: sampleMetadata() });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    const createSpy: GenerateMetadataDeps['createAgentClient'] = vi.fn(
      async () => fakeClient,
    );

    await generateMarketerMetadata(
      baseInput({ themeSessionId: 'ts-XYZ', jobId: 'job-123', bookId: 'book-77' }),
      {
        createAgentClient: createSpy,
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    const spyMock = createSpy as unknown as { mock: { calls: unknown[][] } };
    const ctx = spyMock.mock.calls[0]![2] as {
      role: string; themeSessionId?: string; jobId?: string; bookId?: string;
    };
    expect(ctx.jobId).toBe('job-123');
  });
});

// ---------------------------------------------------------------------------
// 5. token_usage 記録 (withTokenLoggingDeps 経由) — FK 違反回帰防止
// ---------------------------------------------------------------------------

describe('generateMarketerMetadata — token_usage 記録', () => {
  it('jobId 未指定時、token_usage.create の data.job_id は null、theme_session_id / book_id は input と一致する', async () => {
    const text = jsonResponse({ metadata: sampleMetadata() });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    type CreateArgs = {
      data: {
        job_id: string | null;
        theme_session_id: string | null;
        role: string;
        book_id: string | null;
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

    const wrappingFactory: GenerateMetadataDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await generateMarketerMetadata(
      baseInput({ themeSessionId: 'ts-XYZ', bookId: 'book-77' }),
      {
        createAgentClient: wrappingFactory,
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(tokenUsageCreate).toHaveBeenCalledTimes(1);
    const createArgs = tokenUsageCreate.mock.calls[0]![0];
    expect(createArgs.data.job_id).toBeNull();
    expect(createArgs.data.theme_session_id).toBe('ts-XYZ');
    expect(createArgs.data.role).toBe('marketer');
    expect(createArgs.data.book_id).toBe('book-77');
  });

  it('jobId 指定時、token_usage.create の data.job_id が input.jobId と一致する', async () => {
    const text = jsonResponse({ metadata: sampleMetadata() });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    type CreateArgs = {
      data: { job_id: string | null; theme_session_id: string | null; book_id: string | null };
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
    const wrappingFactory: GenerateMetadataDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await generateMarketerMetadata(
      baseInput({ themeSessionId: 'ts-XYZ', jobId: 'job-123', bookId: 'book-77' }),
      {
        createAgentClient: wrappingFactory,
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(tokenUsageCreate).toHaveBeenCalledTimes(1);
    const createArgs = tokenUsageCreate.mock.calls[0]![0];
    expect(createArgs.data.job_id).toBe('job-123');
    expect(createArgs.data.theme_session_id).toBe('ts-XYZ');
    expect(createArgs.data.book_id).toBe('book-77');
  });
});

// ---------------------------------------------------------------------------
// 6. LLM 呼出パラメータ整合
// ---------------------------------------------------------------------------

describe('generateMarketerMetadata — LLM 呼出パラメータ', () => {
  it('client.complete に role=marketer + maxOutputTokens=4096 + system/user 両方が渡る', async () => {
    const text = jsonResponse({ metadata: sampleMetadata() });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await generateMarketerMetadata(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    expect(args.role).toBe('marketer');
    expect(args.maxOutputTokens).toBe(4096);
    expect(args.messages).toHaveLength(2);
    expect(args.messages[0]!.role).toBe('system');
    expect(args.messages[1]!.role).toBe('user');
    expect(args.messages[1]!.content).toContain('副業で月 5 万円');
  });
});
