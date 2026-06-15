/**
 * T-08-01 — Marketer エージェント (長期出版プラン生成) 単体テスト。
 *
 * 戦略 (theme.test.ts / metadata.test.ts と同パターン):
 *  - `createAgentClient` を vi.fn() で差し替え、LLMClient.complete を mock
 *  - `loadActivePrompt` は promptLoaderDeps 経由で repo 差替
 *  - token_usage 記録は実 withTokenLogging Proxy で wrap し prisma.tokenUsage.create を assert
 *
 * 検証する F-002 受入基準:
 *  1. 期間内 planned_count 合計が target_count ±20% 以内
 *  2. published_books が 1 冊以上ある場合、series_candidates が 1 件以上
 *
 * NOTE: 実 API は叩かない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentError } from '@a2p/contracts/errors';
import type {
  LLMClient,
  LLMCompleteArgs,
  LLMCompleteResult,
} from '@a2p/contracts/agents';
import type {
  MarketerPlanInput,
  MarketerPlanOutput,
  PlanMonth,
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
const { generatePlan } = await import('../../src/marketer/plan.js');
import type { GeneratePlanDeps } from '../../src/marketer/plan.js';
const { withTokenLogging } = await import('../../src/lib/with-token-logging.js');
import type {
  LoggingContext,
  WithTokenLoggingDeps,
} from '../../src/lib/with-token-logging.js';

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

/** 開始年月から連続する N 月の PlanMonth 配列を生成する。 */
function buildMonths(
  count: number,
  startYm: string,
  plannedCountPerMonth: number,
  withSequel = false,
): PlanMonth[] {
  const [year, month] = startYm.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(year, month - 1 + i);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return {
      ym,
      planned_count: plannedCountPerMonth,
      theme_categories: ['副業', 'ChatGPT 活用'],
      series_candidates: withSequel && i === 0 ? ['副業で月 5 万円 Vol.2'] : [],
    };
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
      usage: { inputTokens: 500, outputTokens: 300 },
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
    id: 'p-marketer-plan-1',
    role: 'marketer_plan',
    genre: null,
    version: 1,
    body:
      'あなたは長期出版プランナーです。\n' +
      '計画月数: {months} / 目標冊数: {target_count}\n' +
      '既出版: {published_books}\n売上トレンド: {sales_trend}',
    status: 'active',
  };
}

function baseInput(overrides: Partial<MarketerPlanInput> = {}): MarketerPlanInput {
  const base: MarketerPlanInput = {
    accountId: overrides.accountId ?? 'acc-1',
    months: overrides.months ?? 3,
    target_count: overrides.target_count ?? 6,
    published_books: overrides.published_books ?? [],
    sales_trend: overrides.sales_trend ?? [],
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
// 1. F-002 受入基準: 総冊数 ±20%
// ---------------------------------------------------------------------------

describe('generatePlan — F-002 受入基準: 総冊数 ±20%', () => {
  it('target_count=6, months=3 で合計 6 冊 (ちょうど) → PASS', async () => {
    // 3 ヶ月 × 2 冊/月 = 6 冊 (target=6 の ±20% = [4.8..7.2])
    const months = buildMonths(3, '2026-07', 2);
    const text = jsonResponse({ months, notes: 'バランスよく配分' });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result: MarketerPlanOutput = await generatePlan(
      baseInput({ months: 3, target_count: 6 }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(result.months).toHaveLength(3);
    const total = result.months.reduce((s, m) => s + m.planned_count, 0);
    expect(total).toBe(6);
    expect(result.notes).toBe('バランスよく配分');
  });

  it('target_count=10, 合計 11 冊 (10% 超過 ≤ 20%) → PASS', async () => {
    // 3 ヶ月で 11 冊: [4, 4, 3] → 10 ±20% = [8..12]
    const months: PlanMonth[] = [
      { ym: '2026-07', planned_count: 4, theme_categories: ['副業'], series_candidates: [] },
      { ym: '2026-08', planned_count: 4, theme_categories: ['副業'], series_candidates: [] },
      { ym: '2026-09', planned_count: 3, theme_categories: ['副業'], series_candidates: [] },
    ];
    const text = jsonResponse({ months });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generatePlan(
      baseInput({ months: 3, target_count: 10 }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    const total = result.months.reduce((s, m) => s + m.planned_count, 0);
    expect(total).toBe(11);
  });

  it('target_count=10, 合計 13 冊 (30% 超過) → AgentError(count_out_of_range)', async () => {
    const months: PlanMonth[] = [
      { ym: '2026-07', planned_count: 5, theme_categories: ['副業'], series_candidates: [] },
      { ym: '2026-08', planned_count: 5, theme_categories: ['副業'], series_candidates: [] },
      { ym: '2026-09', planned_count: 3, theme_categories: ['副業'], series_candidates: [] },
    ];
    const text = jsonResponse({ months });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generatePlan(
        baseInput({ months: 3, target_count: 10 }),
        {
          createAgentClient: vi.fn(async () => fakeClient),
          promptLoaderDeps: { prisma: promptRepo },
        },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/count_out_of_range/);
    const details = (caught as AgentError).details as { total: number; target: number };
    expect(details.total).toBe(13);
    expect(details.target).toBe(10);
  });

  it('target_count=10, 合計 5 冊 (50% 不足) → AgentError(count_out_of_range)', async () => {
    const months: PlanMonth[] = [
      { ym: '2026-07', planned_count: 2, theme_categories: ['副業'], series_candidates: [] },
      { ym: '2026-08', planned_count: 2, theme_categories: ['副業'], series_candidates: [] },
      { ym: '2026-09', planned_count: 1, theme_categories: ['副業'], series_candidates: [] },
    ];
    const text = jsonResponse({ months });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await expect(
      generatePlan(
        baseInput({ months: 3, target_count: 10 }),
        {
          createAgentClient: vi.fn(async () => fakeClient),
          promptLoaderDeps: { prisma: promptRepo },
        },
      ),
    ).rejects.toBeInstanceOf(AgentError);
  });
});

// ---------------------------------------------------------------------------
// 2. F-002 受入基準: 既存シリーズがある場合 → 続編候補 1 件以上
// ---------------------------------------------------------------------------

describe('generatePlan — F-002 受入基準: 続編候補', () => {
  it('published_books あり + series_candidates あり → PASS', async () => {
    // published_books に 1 冊 → series_candidates が 1 件以上必要
    const months = buildMonths(3, '2026-07', 2, /* withSequel */ true);
    const text = jsonResponse({ months });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generatePlan(
      baseInput({
        months: 3,
        target_count: 6,
        published_books: [
          { title: '副業で月 5 万円', genre: 'practical', recent_royalty_jpy: 3000, review_count: 5, avg_stars: 4.2 },
        ],
      }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    const hasSequel = result.months.some((m) => m.series_candidates.length > 0);
    expect(hasSequel).toBe(true);
  });

  it('published_books あり + series_candidates 全ゼロ → AgentError(no_sequel_candidate)', async () => {
    // 続編候補なし → 受入基準違反
    const months = buildMonths(3, '2026-07', 2, /* withSequel */ false);
    const text = jsonResponse({ months });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generatePlan(
        baseInput({
          months: 3,
          target_count: 6,
          published_books: [
            { title: '副業で月 5 万円', genre: 'practical', recent_royalty_jpy: 3000, review_count: 5, avg_stars: 4.2 },
          ],
        }),
        {
          createAgentClient: vi.fn(async () => fakeClient),
          promptLoaderDeps: { prisma: promptRepo },
        },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/no_sequel_candidate/);
  });

  it('published_books なし → 続編候補チェックをスキップして PASS', async () => {
    // published_books = [] → series_candidates なしでも OK
    const months = buildMonths(3, '2026-07', 2, /* withSequel */ false);
    const text = jsonResponse({ months });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generatePlan(
      baseInput({ months: 3, target_count: 6, published_books: [] }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(result.months).toHaveLength(3);
    const hasSequel = result.months.some((m) => m.series_candidates.length > 0);
    expect(hasSequel).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. JSON parse / zod 検証エラー
// ---------------------------------------------------------------------------

describe('generatePlan — 出力検証', () => {
  it('JSON ではないテキスト → AgentError(invalid_output)', async () => {
    const fakeClient = makeFakeClient('これはプランです。3 ヶ月でよろしくお願いします。');
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await expect(
      generatePlan(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it('空文字レスポンス → AgentError(invalid_output: empty)', async () => {
    const fakeClient = makeFakeClient('   ');
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await expect(
      generatePlan(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it('zod 検証失敗 (ym 形式不正) → AgentError(invalid_output)', async () => {
    const months = [
      { ym: '2026/07', planned_count: 2, theme_categories: ['副業'], series_candidates: [] },
    ];
    const text = jsonResponse({ months });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generatePlan(baseInput({ months: 1, target_count: 2 }), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
  });

  it('months が空配列 → zod min(1) 違反 → AgentError', async () => {
    const text = jsonResponse({ months: [] });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await expect(
      generatePlan(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it('JSON が markdown ```json``` フェンスで囲まれていても抽出できる', async () => {
    const months = buildMonths(3, '2026-07', 2);
    const text =
      '以下のプランを提案します。\n```json\n' +
      jsonResponse({ months }) +
      '\n```\n以上です。';
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generatePlan(
      baseInput({ months: 3, target_count: 6 }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(result.months).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 4. prompt-loader 経由でテンプレ取得
// ---------------------------------------------------------------------------

describe('generatePlan — prompt-loader 経由でテンプレ取得', () => {
  it('prisma.prompt.findFirst が role=marketer_plan で呼ばれる', async () => {
    const months = buildMonths(3, '2026-07', 2);
    const text = jsonResponse({ months });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await generatePlan(
      baseInput({ months: 3, target_count: 6 }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(promptRepo.prompt.findFirst).toHaveBeenCalledTimes(1);
    const callArgs = promptRepo.prompt.findFirst.mock.calls[0]![0] as {
      where: { role: string; status: string };
    };
    expect(callArgs.where.role).toBe('marketer_plan');
    expect(callArgs.where.status).toBe('active');
  });

  it('プレースホルダ ({months}/{target_count}/{published_books}/{sales_trend}) が system に差し込まれる', async () => {
    // published_books あり → series_candidates が必要なため withSequel=true
    const months = buildMonths(2, '2026-07', 3, /* withSequel */ true);
    const text = jsonResponse({ months });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await generatePlan(
      baseInput({
        months: 2,
        target_count: 6,
        published_books: [
          { title: '副業テスト本', genre: 'practical', recent_royalty_jpy: 1000, review_count: 3, avg_stars: 3.5 },
        ],
        sales_trend: [
          { ym: '2026-06', total_royalty_jpy: 5000 },
        ],
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
    expect(systemMsg!.content).toContain('2');         // months
    expect(systemMsg!.content).toContain('6');         // target_count
    expect(systemMsg!.content).toContain('副業テスト本');   // published_books
    expect(systemMsg!.content).toContain('2026-06');   // sales_trend
  });

  it('createAgentClient に role=marketer_plan + genre=null + ctx が渡る、jobId 未指定なら ctx.jobId は undefined', async () => {
    const months = buildMonths(3, '2026-07', 2);
    const text = jsonResponse({ months });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    const createSpy: GeneratePlanDeps['createAgentClient'] = vi.fn(
      async () => fakeClient,
    );

    await generatePlan(
      baseInput({ months: 3, target_count: 6 }),
      {
        createAgentClient: createSpy,
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    const spyMock = createSpy as unknown as { mock: { calls: unknown[][] } };
    expect(spyMock.mock.calls).toHaveLength(1);
    const callArgs = spyMock.mock.calls[0]!;
    expect(callArgs[0]).toBe('marketer_plan');
    expect(callArgs[1]).toBeNull();
    const ctx = callArgs[2] as { role: string; jobId?: string };
    expect(ctx.role).toBe('marketer_plan');
    expect(ctx.jobId).toBeUndefined();
  });

  it('input.jobId 指定時は createAgentClient の ctx.jobId にそのまま渡る', async () => {
    const months = buildMonths(3, '2026-07', 2);
    const text = jsonResponse({ months });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    const createSpy: GeneratePlanDeps['createAgentClient'] = vi.fn(
      async () => fakeClient,
    );

    await generatePlan(
      baseInput({ months: 3, target_count: 6, jobId: 'job-888' }),
      {
        createAgentClient: createSpy,
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    const spyMock = createSpy as unknown as { mock: { calls: unknown[][] } };
    const ctx = spyMock.mock.calls[0]![2] as { role: string; jobId?: string };
    expect(ctx.jobId).toBe('job-888');
  });
});

// ---------------------------------------------------------------------------
// 5. token_usage 記録 (withTokenLoggingDeps 経由)
// ---------------------------------------------------------------------------

describe('generatePlan — token_usage 記録', () => {
  it('jobId 未指定時、token_usage.create の data.job_id は null、role は marketer_plan', async () => {
    const months = buildMonths(3, '2026-07', 2);
    const text = jsonResponse({ months });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    type CreateArgs = {
      data: { job_id: string | null; role: string; book_id: string | null };
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

    const wrappingFactory: GeneratePlanDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await generatePlan(
      baseInput({ months: 3, target_count: 6 }),
      {
        createAgentClient: wrappingFactory,
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(tokenUsageCreate).toHaveBeenCalledTimes(1);
    const createArgs = tokenUsageCreate.mock.calls[0]![0];
    expect(createArgs.data.job_id).toBeNull();
    expect(createArgs.data.role).toBe('marketer_plan');
    expect(createArgs.data.book_id).toBeNull();
  });

  it('jobId 指定時、token_usage.create の data.job_id が input.jobId と一致する', async () => {
    const months = buildMonths(3, '2026-07', 2);
    const text = jsonResponse({ months });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    type CreateArgs = { data: { job_id: string | null } };
    const tokenUsageCreate = vi.fn(async (_args: CreateArgs) => undefined);
    const wrappingDeps: WithTokenLoggingDeps = {
      prisma: {
        tokenUsage: { create: tokenUsageCreate },
        book: { update: vi.fn() },
      } as never,
      logger: { warn: vi.fn() },
      fetchPriceSnapshot: async () => ({}),
    };
    const wrappingFactory: GeneratePlanDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await generatePlan(
      baseInput({ months: 3, target_count: 6, jobId: 'job-999' }),
      {
        createAgentClient: wrappingFactory,
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    expect(tokenUsageCreate).toHaveBeenCalledTimes(1);
    const createArgs = tokenUsageCreate.mock.calls[0]![0];
    expect(createArgs.data.job_id).toBe('job-999');
  });
});

// ---------------------------------------------------------------------------
// 6. LLM 呼出パラメータ整合
// ---------------------------------------------------------------------------

describe('generatePlan — LLM 呼出パラメータ', () => {
  it('client.complete に role=marketer_plan + maxOutputTokens=4096 + system/user 両方が渡る', async () => {
    const months = buildMonths(3, '2026-07', 2);
    const text = jsonResponse({ months });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await generatePlan(
      baseInput({ months: 3, target_count: 6 }),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      },
    );

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    expect(args.role).toBe('marketer_plan');
    expect(args.maxOutputTokens).toBe(4096);
    expect(args.messages).toHaveLength(2);
    expect(args.messages[0]!.role).toBe('system');
    expect(args.messages[1]!.role).toBe('user');
    expect(args.messages[1]!.content).toContain('6');  // target_count
    expect(args.messages[1]!.content).toContain('3');  // months
  });
});
