/**
 * T-03-01 — Marketer エージェント (テーマ生成) 単体テスト。
 *
 * 戦略:
 *  - `createAgentClient` を vi.fn() で差し替え、LLMClient.complete を mock する
 *    (= AgentSdkClient / Anthropic SDK を直接 mock せず、factory 注入経路で済ます)
 *  - `loadActivePrompt` / `prisma.prompt.findFirst` は @a2p/db mock + promptLoaderDeps
 *    両方の経路を検証する
 *  - token_usage 記録は withTokenLoggingDeps の prisma 経由で create 呼出回数を確認
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
  MarketerThemeInput,
  ThemeCandidate,
} from '@a2p/contracts/agents/marketer';

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

// import 順: vi.mock より後に SUT を読む
const { generateMarketerThemes } = await import('../../src/marketer/theme.js');
import type { GenerateThemesDeps } from '../../src/marketer/theme.js';
const { withTokenLogging } = await import('../../src/lib/with-token-logging.js');
import type {
  LoggingContext,
  WithTokenLoggingDeps,
} from '../../src/lib/with-token-logging.js';

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

function sampleCandidate(overrides: Partial<ThemeCandidate> = {}): ThemeCandidate {
  return {
    title: overrides.title ?? 'デフォルトタイトル',
    subtitle: overrides.subtitle ?? '副題',
    hook: overrides.hook ?? '既存本にない切り口で 30 代副業初心者に最短ルートを示す',
    target_reader: overrides.target_reader ?? '30 代会社員 / 副業初心者',
    competitors: overrides.competitors ?? [
      { title: '副業の始め方', author: '山田太郎', asin: 'B01ABCDEFG', url: 'https://example.com/a' },
    ],
    signals: overrides.signals ?? {
      reasoning: '市場の検索ボリュームが高く、既存競合本が古いため。',
      market_score: 75,
      predicted_chapters: 8,
      search_keywords: ['副業', '初心者', '在宅'],
      sources: [],
      bestseller_evidence: [],
    },
  };
}

function buildCandidates(count: number): ThemeCandidate[] {
  return Array.from({ length: count }, (_, i) =>
    sampleCandidate({ title: `テーマ${i + 1}` }),
  );
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
    body: 'あなたはマーケターです。ブリーフ: {brief} / ジャンル: {genre} / 件数: {count}\n避けるタイトル:\n{exclude_titles}',
    status: 'active',
  };
}

function baseInput(overrides: Partial<MarketerThemeInput> = {}): MarketerThemeInput {
  const base: MarketerThemeInput = {
    themeSessionId: overrides.themeSessionId ?? 'ts-1',
    accountId: overrides.accountId ?? 'acc-1',
    genre: overrides.genre ?? null,
    keywordOrBrief: overrides.keywordOrBrief ?? '副業で月 5 万円',
    excludeTitlesRecent: overrides.excludeTitlesRecent ?? [],
    count: overrides.count ?? 10,
  };
  if (overrides.jobId !== undefined) base.jobId = overrides.jobId;
  return base;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. 10 件生成 happy path
// ---------------------------------------------------------------------------

describe('generateMarketerThemes — happy path', () => {
  it('10 件のテーマを生成し candidates として返す', async () => {
    const text = jsonResponse({ candidates: buildCandidates(10), notes: 'looks good' });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateMarketerThemes(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.candidates).toHaveLength(10);
    expect(result.notes).toBe('looks good');
    expect(result.candidates[0]!.title).toBe('テーマ1');
    expect(result.candidates[0]!.competitors).toHaveLength(1);
    expect(result.candidates[0]!.signals.market_score).toBe(75);
    expect(fakeClient.complete).toHaveBeenCalledTimes(1);
  });

  it('count=5 指定で 5 件を返す (LLM が 5 件返した場合)', async () => {
    const text = jsonResponse({ candidates: buildCandidates(5) });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateMarketerThemes(
      baseInput({ count: 5 }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(result.candidates).toHaveLength(5);
  });

  it('JSON 文字列値内に生改行 (\\n / \\r / \\t) が混入していても sanitize して parse できる', async () => {
    // LLM (web_search 経由) が paraphrase / hook / reasoning 内に生改行を escape せず
    // 埋め込むケース。tryParse の sanitizeJsonStringNewlines fallback が救う想定。
    const raw =
      '{ "candidates": [ ' +
      '{ "title": "テーマ1", ' +
      '"hook": "...本書は、\nリモートワーク下で「ソロワークで孤軍奮闘」する課題\nに焦点を絞り、解決策を示す。", ' +
      '"target_reader": "30代 会社員", ' +
      '"competitors": [], ' +
      '"signals": { "reasoning": "市場の検索ボリュームが\r高く、\t既存競合本が古いため。", ' +
      '"market_score": 70, "predicted_chapters": 8, "search_keywords": ["a","b"] } } ' +
      '] }';
    const fakeClient = makeFakeClient(raw);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateMarketerThemes(
      baseInput({ count: 1 }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.title).toBe('テーマ1');
    // 改行が文字列リテラル内で保持されている (\\n エスケープ後 parse すると `\n` に復元)
    expect(result.candidates[0]!.hook).toContain('\n');
    expect(result.candidates[0]!.signals.reasoning).toContain('\r');
    expect(result.candidates[0]!.signals.reasoning).toContain('\t');
  });

  it('JSON が markdown ```json``` フェンスで囲まれていても抽出できる', async () => {
    const text = '少しの説明文。\n```json\n' +
      jsonResponse({ candidates: buildCandidates(3) }) +
      '\n```\n以上です。';
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateMarketerThemes(
      baseInput({ count: 3 }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(result.candidates).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 2. 重複除外
// ---------------------------------------------------------------------------

describe('generateMarketerThemes — 重複除外', () => {
  it('candidates 内の同一 title は 1 件に dedupe される', async () => {
    const dup = [
      sampleCandidate({ title: 'テーマA' }),
      sampleCandidate({ title: 'テーマA' }),
      sampleCandidate({ title: 'テーマB' }),
    ];
    const text = jsonResponse({ candidates: dup });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateMarketerThemes(
      baseInput({ count: 3 }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(result.candidates.map((c) => c.title)).toEqual(['テーマA', 'テーマB']);
  });

  it('excludeTitlesRecent に含まれる title は除外される', async () => {
    const text = jsonResponse({
      candidates: [
        sampleCandidate({ title: '副業の始め方' }),
        sampleCandidate({ title: '新しいテーマ' }),
      ],
    });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateMarketerThemes(
      baseInput({
        excludeTitlesRecent: ['副業の始め方', '別の既出版本'],
        count: 2,
      }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.title).toBe('新しいテーマ');
  });

  it('全候補が exclude と重複 → AgentError(all_duplicates)', async () => {
    const text = jsonResponse({
      candidates: [
        sampleCandidate({ title: 'A' }),
        sampleCandidate({ title: 'B' }),
      ],
    });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await expect(
      generateMarketerThemes(
        baseInput({
          excludeTitlesRecent: ['A', 'B'],
          count: 2,
        }),
        {
          createAgentClient: vi.fn(async () => fakeClient),
          promptLoaderDeps: { prisma: promptRepo },
        },
      ),
    ).rejects.toBeInstanceOf(AgentError);
  });
});

// ---------------------------------------------------------------------------
// 3. JSON parse / zod 検証エラー
// ---------------------------------------------------------------------------

describe('generateMarketerThemes — 出力検証', () => {
  it('JSON ではないテキスト → AgentError(invalid_output)', async () => {
    const fakeClient = makeFakeClient('I am not JSON at all, sorry.');
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateMarketerThemes(baseInput(), {
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
      generateMarketerThemes(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it('zod 検証失敗 (required field 欠落) → AgentError(invalid_output)', async () => {
    // title 欠落 + signals 欠落
    const text = jsonResponse({
      candidates: [
        {
          hook: 'no title!',
          target_reader: 'p',
        },
      ],
    });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateMarketerThemes(baseInput({ count: 1 }), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).details).toMatchObject({ rawText: expect.any(String) });
  });

  it('candidates が空配列 → zod min(1) 違反 → AgentError', async () => {
    const text = jsonResponse({ candidates: [] });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await expect(
      generateMarketerThemes(baseInput({ count: 5 }), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });
});

// ---------------------------------------------------------------------------
// 4. prompt-loader 経由でテンプレ取得
// ---------------------------------------------------------------------------

describe('generateMarketerThemes — prompt-loader 経由でテンプレ取得', () => {
  it('prisma.prompt.findFirst が role=marketer で呼ばれる', async () => {
    const text = jsonResponse({ candidates: buildCandidates(3) });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await generateMarketerThemes(baseInput({ count: 3 }), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(promptRepo.prompt.findFirst).toHaveBeenCalledTimes(1);
    const callArgs = promptRepo.prompt.findFirst.mock.calls[0]![0] as {
      where: { role: string; status: string; OR: Array<{ genre: string | null }> };
    };
    expect(callArgs.where.role).toBe('marketer');
    expect(callArgs.where.status).toBe('active');
    // genre=null 指定 → OR には { genre: null } のみ含まれる
    expect(callArgs.where.OR).toEqual(expect.arrayContaining([{ genre: null }]));
  });

  it('プレースホルダ ({brief}/{count}/{genre}/{exclude_titles}) が system に差し込まれる', async () => {
    const text = jsonResponse({ candidates: buildCandidates(2) });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await generateMarketerThemes(
      baseInput({
        keywordOrBrief: 'ChatGPT 副業',
        count: 2,
        genre: 'business',
        excludeTitlesRecent: ['古い本'],
      }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: {
          prisma: makePromptRepo([{ ...defaultPromptRow(), genre: 'business' }]),
        },
      },
    );

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    const systemMsg = args.messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg!.content).toContain('ChatGPT 副業');
    expect(systemMsg!.content).toContain('ビジネス書');
    expect(systemMsg!.content).toContain('2'); // count
    expect(systemMsg!.content).toContain('古い本');
  });

  it('createAgentClient に themeSessionId / role=marketer が渡り、jobId 未指定なら ctx.jobId は undefined', async () => {
    const text = jsonResponse({ candidates: buildCandidates(2) });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    const createSpy: GenerateThemesDeps['createAgentClient'] = vi.fn(
      async () => fakeClient,
    );

    await generateMarketerThemes(
      baseInput({ themeSessionId: 'ts-XYZ', count: 2 }),
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
    expect(callArgs[0]).toBe('marketer');
    expect(callArgs[1]).toBeNull();
    const ctx = callArgs[2] as { role: string; themeSessionId: string; jobId?: string };
    expect(ctx).toMatchObject({
      role: 'marketer',
      themeSessionId: 'ts-XYZ',
    });
    // jobId 未指定なら ctx に key 自体含めない → token_usage.job_id = null (FK 違反回避)
    expect(ctx.jobId).toBeUndefined();
  });

  it('input.jobId 指定時は createAgentClient の ctx.jobId にそのまま渡る', async () => {
    const text = jsonResponse({ candidates: buildCandidates(2) });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    const createSpy: GenerateThemesDeps['createAgentClient'] = vi.fn(
      async () => fakeClient,
    );

    await generateMarketerThemes(
      baseInput({ themeSessionId: 'ts-XYZ', jobId: 'job-123', count: 2 }),
      {
        createAgentClient: createSpy,
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    const spyMock = createSpy as unknown as {
      mock: { calls: unknown[][] };
    };
    const ctx = spyMock.mock.calls[0]![2] as {
      role: string; themeSessionId: string; jobId?: string;
    };
    expect(ctx.jobId).toBe('job-123');
  });
});

// ---------------------------------------------------------------------------
// 5. token_usage 記録 (withTokenLoggingDeps 経由)
// ---------------------------------------------------------------------------

describe('generateMarketerThemes — token_usage 記録', () => {
  it('jobId 未指定時、token_usage.create の data.job_id は null、theme_session_id は input.themeSessionId と一致する (FK 違反回帰防止)', async () => {
    // mini factory: 実 withTokenLogging で raw client をラップする。
    // これにより generateMarketerThemes → factory → withTokenLogging → prisma.tokenUsage.create
    // の経路全体を実 Proxy で再現し、ctx.jobId が undefined の場合に
    // INSERT data.job_id が null になることを直接検証する。
    const text = jsonResponse({ candidates: buildCandidates(2) });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    type CreateArgs = { data: { job_id: string | null; theme_session_id: string | null; role: string; book_id: string | null } };
    const tokenUsageCreate = vi.fn(async (_args: CreateArgs) => undefined);
    const wrappingDeps: WithTokenLoggingDeps = {
      prisma: {
        tokenUsage: { create: tokenUsageCreate },
        book: { update: vi.fn() },
      } as never,
      logger: { warn: vi.fn() },
      fetchPriceSnapshot: async () => ({ snap: true }),
    };

    const wrappingFactory: GenerateThemesDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await generateMarketerThemes(
      // jobId 未指定 — UI 直接呼び出し相当
      baseInput({ themeSessionId: 'ts-XYZ', count: 2 }),
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
    expect(createArgs.data.book_id).toBeNull();
  });

  it('jobId 指定時、token_usage.create の data.job_id が input.jobId と一致する', async () => {
    const text = jsonResponse({ candidates: buildCandidates(2) });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    type CreateArgs = { data: { job_id: string | null; theme_session_id: string | null } };
    const tokenUsageCreate = vi.fn(async (_args: CreateArgs) => undefined);
    const wrappingDeps: WithTokenLoggingDeps = {
      prisma: {
        tokenUsage: { create: tokenUsageCreate },
        book: { update: vi.fn() },
      } as never,
      logger: { warn: vi.fn() },
      fetchPriceSnapshot: async () => ({}),
    };
    const wrappingFactory: GenerateThemesDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await generateMarketerThemes(
      baseInput({ themeSessionId: 'ts-XYZ', jobId: 'job-123', count: 2 }),
      {
        createAgentClient: wrappingFactory,
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(tokenUsageCreate).toHaveBeenCalledTimes(1);
    const createArgs = tokenUsageCreate.mock.calls[0]![0];
    expect(createArgs.data.job_id).toBe('job-123');
    expect(createArgs.data.theme_session_id).toBe('ts-XYZ');
  });

  it('factory に withTokenLoggingDeps を素通しできる (実 wrap は factory 内で行われる)', async () => {
    // 本テストは generateMarketerThemes が withTokenLoggingDeps を
    // createAgentClient に正しく forward することを保証する。
    // 実 INSERT 検証は llm-client-factory.test.ts / with-token-logging.test.ts が担う。
    const text = jsonResponse({ candidates: buildCandidates(2) });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    const tokenUsageCreate = vi.fn(async () => undefined);
    const fakePrisma = {
      tokenUsage: { create: tokenUsageCreate },
      book: { update: vi.fn() },
    };

    const createSpy: GenerateThemesDeps['createAgentClient'] = vi.fn(
      async () => fakeClient,
    );

    await generateMarketerThemes(
      baseInput({ count: 2 }),
      {
        createAgentClient: createSpy,
        promptLoaderDeps: { prisma: promptRepo },
        withTokenLoggingDeps: {
          prisma: fakePrisma as never,
          logger: { warn: vi.fn() },
          fetchPriceSnapshot: async () => ({ snap: true }),
        },
        loadAssignmentDeps: { prisma: {} as never },
        getApiKey: async () => 'sk-test',
      },
    );

    // withTokenLoggingDeps が createAgentClient に渡されたことを deps オブジェクト経由で確認
    const spyMock = createSpy as unknown as {
      mock: { calls: unknown[][] };
    };
    const factoryDeps = spyMock.mock.calls[0]![3] as {
      withTokenLoggingDeps?: { prisma: unknown };
      getApiKey?: unknown;
    };
    expect(factoryDeps).toBeDefined();
    expect(factoryDeps.withTokenLoggingDeps?.prisma).toBe(fakePrisma);
    expect(factoryDeps.getApiKey).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. LLM 呼出パラメータ整合
// ---------------------------------------------------------------------------

describe('generateMarketerThemes — LLM 呼出パラメータ', () => {
  it('client.complete に role=marketer + maxOutputTokens=8192 + system/user 両方が渡る', async () => {
    const text = jsonResponse({ candidates: buildCandidates(2) });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await generateMarketerThemes(baseInput({ count: 2 }), {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    expect(args.role).toBe('marketer');
    expect(args.maxOutputTokens).toBe(8192);
    expect(args.messages).toHaveLength(2);
    expect(args.messages[0]!.role).toBe('system');
    expect(args.messages[1]!.role).toBe('user');
    expect(args.messages[1]!.content).toContain('副業で月 5 万円');
  });
});
