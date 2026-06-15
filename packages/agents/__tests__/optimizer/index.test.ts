/**
 * SP-11 T-11-01 — Optimizer エージェント (optimizePrompt) 単体テスト。
 *
 * 戦略 (judge/index.test.ts と同パターン):
 *  - `createAgentClient` を vi.fn() で差し替え、LLMClient.complete を mock する
 *  - `loadActivePrompt` は OptimizerDeps 経由で stub を渡す
 *  - token_usage 記録は withTokenLoggingDeps の prisma 経由で create 呼出回数を確認
 *
 * カバレッジ (§T-11-01 受け入れ基準):
 *  1. 正常系: OptimizerOutput が返る
 *  2. 異常系: 不正 JSON → AgentError
 *  3. 異常系: 空レスポンス → AgentError
 *  4. 異常系: schema 違反 JSON → AgentError
 *  5. withTokenLoggingDeps.prisma.tokenUsage.create が 1 回呼ばれる
 *  6. createAgentClient が role='optimizer', bookId=undefined で呼ばれる
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
import type { OptimizerInput } from '@a2p/contracts/agents/optimizer';

// Prisma を引かないよう @a2p/db を mock。テストは deps 経由で差し替える。
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

const { optimizePrompt } = await import('../../src/optimizer/index.js');
import type { OptimizerDeps } from '../../src/optimizer/index.js';

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

function makeFakeClient(text: string, tokenUsageCreate?: ReturnType<typeof vi.fn>): LLMClient {
  const completeImpl = async <T = string>(
    _args: LLMCompleteArgs,
  ): Promise<LLMCompleteResult<T>> => {
    if (tokenUsageCreate) {
      await tokenUsageCreate({
        data: {
          book_id: null,
          job_id: null,
          provider: 'anthropic',
          model: 'claude-opus-4-7',
          role: 'optimizer',
          input_tokens: 2000,
          output_tokens: 512,
          cached_input_tokens: 0,
          image_count: 0,
          unit_price_snapshot: {},
          cost_jpy: 0,
        },
      });
    }
    return {
      text: text as T,
      usage: { inputTokens: 2000, outputTokens: 512 },
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

function buildValidOptimizerResponse(): string {
  return JSON.stringify({
    proposed_body: '# 改訂後プロンプト\n\nあなたは書籍生成エージェントです。改善版の指示を従ってください。',
    diff: '--- old\n+++ new\n@@ -1 +1 @@\n-旧プロンプト\n+新プロンプト',
    rationale: 'スコアが低い benefit_clarity 軸を改善するため、読者ベネフィットの明示化指示を追加しました。',
    expected_effect: {
      score_delta: 5.0,
      sales_delta_pct: 3.5,
    },
    sample_output: '読者が明確なベネフィットを感じられる書籍の出力例です。',
  });
}

function makeLoadActivePromptStub() {
  return vi.fn(async (_role: string, _genre: string | null) => ({
    template:
      'あなたは Optimizer です。対象: {role} ジャンル: {genre} ' +
      '評価件数: {eval_count} 現行プロンプト: {current_prompt} ' +
      '評価サマリ: {eval_summary} 販売サマリ: {sales_summary}',
    version: 1,
    promptId: 'p-optimizer-1',
    genre: null,
  }));
}

function baseInput(overrides: Partial<OptimizerInput> = {}): OptimizerInput {
  return {
    role: overrides.role ?? 'writer',
    genre: overrides.genre !== undefined ? overrides.genre : 'business',
    job_id: overrides.job_id,
    recent_evals: overrides.recent_evals ?? [
      {
        book_id: 'book-001',
        score_total: 72,
        score_breakdown: { benefit_clarity: 60, logical_consistency: 75 },
        prompt_version_id: 'prompt-v1',
      },
      {
        book_id: 'book-002',
        score_total: 68,
        score_breakdown: { benefit_clarity: 55, logical_consistency: 70 },
        prompt_version_id: 'prompt-v1',
      },
    ],
    recent_sales: overrides.recent_sales ?? [
      { book_id: 'book-001', royalty_jpy: 1200, avg_stars: 4.2 },
      { book_id: 'book-002', royalty_jpy: 800, avg_stars: null },
    ],
    current_prompt: overrides.current_prompt ?? {
      id: 'prompt-v1',
      body: '# Writer プロンプト\n\nあなたは書籍ライターです。',
      version: 1,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. 正常系: OptimizerOutput が返る
// ---------------------------------------------------------------------------

describe('optimizePrompt — 正常系', () => {
  it('正常なレスポンスで OptimizerOutput が返る', async () => {
    const text = buildValidOptimizerResponse();
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    const result = await optimizePrompt(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as OptimizerDeps);

    expect(result.proposed_body).toBeTruthy();
    expect(result.proposed_body.length).toBeGreaterThan(0);
    expect(result.diff).toBeTruthy();
    expect(result.rationale).toBeTruthy();
    expect(result.expected_effect).toBeDefined();
  });

  it('genre=null でも正常に動作する', async () => {
    const text = buildValidOptimizerResponse();
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    const result = await optimizePrompt(baseInput({ genre: null }), {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as OptimizerDeps);

    expect(result.proposed_body).toBeTruthy();
  });

  it('job_id が指定されると ctx.jobId に渡される', async () => {
    const text = buildValidOptimizerResponse();
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();
    const createSpy = vi.fn(async () => fakeClient);

    await optimizePrompt(baseInput({ job_id: 'job-optimizer-123' }), {
      createAgentClient: createSpy,
      loadActivePrompt,
    } as OptimizerDeps);

    const callArgs = createSpy.mock.calls[0] as unknown[];
    const ctx = callArgs[2] as { role: string; bookId?: string; jobId?: string };
    expect(ctx.role).toBe('optimizer');
    expect(ctx.bookId).toBeUndefined();
    expect(ctx.jobId).toBe('job-optimizer-123');
  });

  it('recent_evals が空でも動作する', async () => {
    const text = buildValidOptimizerResponse();
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    const result = await optimizePrompt(baseInput({ recent_evals: [] }), {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as OptimizerDeps);

    expect(result.proposed_body).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 2. token_usage.create が 1 回呼ばれる
// ---------------------------------------------------------------------------

describe('optimizePrompt — token_usage 記録', () => {
  it('withTokenLoggingDeps.prisma.tokenUsage.create が 1 回呼ばれる', async () => {
    const text = buildValidOptimizerResponse();
    const tokenUsageCreate = vi.fn(async () => ({}));
    const fakeClient = makeFakeClient(text, tokenUsageCreate);
    const loadActivePrompt = makeLoadActivePromptStub();

    await optimizePrompt(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as OptimizerDeps);

    expect(tokenUsageCreate).toHaveBeenCalledTimes(1);
    const callData = (tokenUsageCreate.mock.calls[0] as unknown[])[0] as { data: Record<string, unknown> };
    expect(callData.data.role).toBe('optimizer');
    expect(callData.data.book_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. createAgentClient 呼出引数確認
// ---------------------------------------------------------------------------

describe('optimizePrompt — createAgentClient 呼出', () => {
  it("createAgentClient が role='optimizer', genre=null, ctx.bookId=undefined で呼ばれる", async () => {
    const text = buildValidOptimizerResponse();
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();
    const createSpy: OptimizerDeps['createAgentClient'] = vi.fn(async () => fakeClient);

    await optimizePrompt(baseInput(), {
      createAgentClient: createSpy,
      loadActivePrompt,
    } as OptimizerDeps);

    const spyMock = createSpy as unknown as { mock: { calls: unknown[][] } };
    expect(spyMock.mock.calls).toHaveLength(1);
    const callArgs = spyMock.mock.calls[0]!;
    expect(callArgs[0]).toBe('optimizer');
    expect(callArgs[1]).toBeNull();
    const ctx = callArgs[2] as { role: string; bookId?: string };
    expect(ctx.role).toBe('optimizer');
    expect(ctx.bookId).toBeUndefined();
  });

  it("loadActivePrompt が role='optimizer', genre=null で呼ばれる", async () => {
    const text = buildValidOptimizerResponse();
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    await optimizePrompt(baseInput({ genre: 'practical' }), {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as OptimizerDeps);

    expect(loadActivePrompt).toHaveBeenCalledTimes(1);
    // optimizer は常に genre=null でプロンプトを取得する
    expect(loadActivePrompt).toHaveBeenCalledWith('optimizer', null, undefined);
  });

  it('client.complete に role=optimizer + maxOutputTokens=4096 + system/user が渡る', async () => {
    const text = buildValidOptimizerResponse();
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    await optimizePrompt(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as OptimizerDeps);

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    expect(args.role).toBe('optimizer');
    expect(args.maxOutputTokens).toBe(4096);
    expect(args.messages).toHaveLength(2);
    expect(args.messages[0]!.role).toBe('system');
    expect(args.messages[1]!.role).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// 4. 異常系: JSON parse 失敗 → AgentError
// ---------------------------------------------------------------------------

describe('optimizePrompt — JSON parse 失敗', () => {
  it('不正な JSON テキスト → AgentError(invalid_output)', async () => {
    const fakeClient = makeFakeClient('これは JSON ではありません。Sorry.');
    const loadActivePrompt = makeLoadActivePromptStub();

    let caught: unknown;
    try {
      await optimizePrompt(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        loadActivePrompt,
      } as OptimizerDeps);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
  });

  it('proposed_body を持たない JSON → AgentError(invalid_output)', async () => {
    const fakeClient = makeFakeClient(JSON.stringify({ diff: 'some diff', rationale: 'test' }));
    const loadActivePrompt = makeLoadActivePromptStub();

    let caught: unknown;
    try {
      await optimizePrompt(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        loadActivePrompt,
      } as OptimizerDeps);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
  });

  it('空レスポンス → AgentError(invalid_output: empty)', async () => {
    const fakeClient = makeFakeClient('   ');
    const loadActivePrompt = makeLoadActivePromptStub();

    await expect(
      optimizePrompt(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        loadActivePrompt,
      } as OptimizerDeps),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it('schema 違反 JSON (proposed_body が空文字) → AgentError(invalid_output: schema validation)', async () => {
    const fakeClient = makeFakeClient(
      JSON.stringify({
        proposed_body: '', // min(1) 違反
        diff: 'diff',
        rationale: '理由',
        expected_effect: {},
      }),
    );
    const loadActivePrompt = makeLoadActivePromptStub();

    let caught: unknown;
    try {
      await optimizePrompt(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        loadActivePrompt,
      } as OptimizerDeps);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
  });
});

// ---------------------------------------------------------------------------
// 5. プレースホルダ差込確認
// ---------------------------------------------------------------------------

describe('optimizePrompt — プレースホルダ差込', () => {
  it('system メッセージに role/genre/eval_count が含まれる', async () => {
    const text = buildValidOptimizerResponse();
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    await optimizePrompt(
      baseInput({ role: 'editor', genre: 'self_help', recent_evals: [
        {
          book_id: 'book-X',
          score_total: 80,
          score_breakdown: { benefit_clarity: 80 },
          prompt_version_id: 'p-v2',
        },
      ]}),
      {
        createAgentClient: vi.fn(async () => fakeClient),
        loadActivePrompt,
      } as OptimizerDeps,
    );

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    const systemMsg = args.messages.find((m) => m.role === 'system');
    expect(systemMsg!.content).toContain('editor');
    expect(systemMsg!.content).toContain('self_help');
    expect(systemMsg!.content).toContain('1'); // eval_count
  });
});
