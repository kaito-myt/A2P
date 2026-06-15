/**
 * T-10-08 — Judge エージェント (judgeBook) 単体テスト。
 *
 * 戦略 (editor/index.test.ts と同パターン):
 *  - `createAgentClient` を vi.fn() で差し替え、LLMClient.complete を mock する
 *  - `loadActivePrompt` は JudgeBookDeps 経由で stub を渡す
 *  - token_usage 記録は withTokenLoggingDeps の prisma 経由で create 呼出回数を確認
 *
 * カバレッジ (§T-10-08 のケース):
 *  1. 6 軸スコアの平均を score_total に設定する (LLM 出力の score_total を無視)
 *  2. JSON parse 失敗で AgentError をスロー (不正レスポンス)
 *  3. createAgentClient が role='judge' で呼ばれる (呼出引数 assert)
 *  4. score_total は 0-100 の範囲に収まる
 *  5. 空レスポンス → AgentError(invalid_output: empty)
 *  6. loadActivePrompt('judge', genre) が呼ばれプレースホルダ差込結果が LLM に渡る
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
import type { JudgeInput } from '@a2p/contracts/agents/judge';

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

const { judgeBook } = await import('../../src/judge/index.js');
import type { JudgeBookDeps } from '../../src/judge/index.js';

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

function makeFakeClient(text: string): LLMClient {
  const completeImpl = async <T = string>(
    _args: LLMCompleteArgs,
  ): Promise<LLMCompleteResult<T>> => {
    return {
      text: text as T,
      usage: { inputTokens: 4000, outputTokens: 1024 },
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
 * 6 軸スコアと任意の score_total を持つ LLM 応答 JSON を生成。
 * score_total_override を指定すると、6 軸平均とは異なる値を LLM が返す状況を再現できる。
 */
function buildJudgeResponse(opts: {
  benefit_clarity?: number;
  logical_consistency?: number;
  style_consistency?: number;
  japanese_naturalness?: number;
  title_alignment?: number;
  genre_fit?: number;
  score_total_override?: number;
} = {}): string {
  const scores = {
    benefit_clarity: opts.benefit_clarity ?? 80,
    logical_consistency: opts.logical_consistency ?? 75,
    style_consistency: opts.style_consistency ?? 70,
    japanese_naturalness: opts.japanese_naturalness ?? 85,
    title_alignment: opts.title_alignment ?? 90,
    genre_fit: opts.genre_fit ?? 65,
  };
  const avg = Math.floor(
    Object.values(scores).reduce((s, v) => s + v, 0) / 6,
  );
  const score_total = opts.score_total_override ?? avg;

  return JSON.stringify({
    score_total,
    score_breakdown: scores,
    judge_comments: {
      benefit_clarity: 'ベネフィットは明確に伝わっています。',
      logical_consistency: '論理構成は整っています。',
      style_consistency: '文体は概ね一貫しています。',
      japanese_naturalness: '自然な日本語で書かれています。',
      title_alignment: 'タイトルとの整合性は高い。',
      genre_fit: 'ジャンルに合った内容です。',
      overall: '全体的に品質の高い原稿です。',
    },
  });
}

function makeLoadActivePromptStub() {
  return vi.fn(async (_role: string, _genre: string | null) => ({
    template:
      'あなたは採点者です。タイトル: {theme_title} 副題: {theme_subtitle} フック: {theme_hook} ' +
      '読者: {target_reader} ジャンル: {genre} 章数: {chapter_count} ' +
      '草稿: {draft_chapters} アウトライン: {outline_summary}',
    version: 1,
    promptId: 'p-judge-1',
    genre: null,
  }));
}

function baseInput(overrides: Partial<JudgeInput> = {}): JudgeInput {
  return {
    book_id: overrides.book_id ?? 'book-judge-1',
    job_id: overrides.job_id,
    genre: overrides.genre !== undefined ? overrides.genre : null,
    theme_context: overrides.theme_context ?? {
      title: 'テスト書籍タイトル',
      subtitle: 'テスト副題',
      hook: '既存本にない切り口',
      target_reader: '30 代ビジネスパーソン',
    },
    outline_summary: overrides.outline_summary ?? 'アウトライン概要テキスト（テスト用）',
    chapters: overrides.chapters ?? [
      { index: 1, heading: '第1章 はじめに', body_md: 'はじめに本章では'.repeat(50) },
      { index: 2, heading: '第2章 基礎知識', body_md: '基礎知識について'.repeat(50) },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. 6 軸スコアの平均を score_total に設定する
// ---------------------------------------------------------------------------

describe('judgeBook — 6 軸スコア集計', () => {
  it('LLM が返した score_total を無視し、6 軸平均 (Math.floor(sum/6)) を score_total に採用する', async () => {
    const axes = {
      benefit_clarity: 80,
      logical_consistency: 75,
      style_consistency: 70,
      japanese_naturalness: 85,
      title_alignment: 90,
      genre_fit: 65,
    };
    // 6 軸合計 = 465、Math.floor(465/6) = 77
    const expectedTotal = Math.floor((80 + 75 + 70 + 85 + 90 + 65) / 6);
    // LLM は意図的に異なる score_total (99) を返す
    const text = buildJudgeResponse({ ...axes, score_total_override: 99 });
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    const result = await judgeBook(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as JudgeBookDeps);

    expect(result.score_total).toBe(expectedTotal);
    expect(result.score_total).not.toBe(99);
    expect(result.score_breakdown.benefit_clarity).toBe(80);
    expect(result.score_breakdown.genre_fit).toBe(65);
  });

  it('全軸 100 → score_total = 100', async () => {
    const text = buildJudgeResponse({
      benefit_clarity: 100,
      logical_consistency: 100,
      style_consistency: 100,
      japanese_naturalness: 100,
      title_alignment: 100,
      genre_fit: 100,
      score_total_override: 0, // LLM は 0 を返すが上書きされる
    });
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    const result = await judgeBook(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as JudgeBookDeps);

    expect(result.score_total).toBe(100);
  });

  it('全軸 0 → score_total = 0', async () => {
    const text = buildJudgeResponse({
      benefit_clarity: 0,
      logical_consistency: 0,
      style_consistency: 0,
      japanese_naturalness: 0,
      title_alignment: 0,
      genre_fit: 0,
      score_total_override: 100, // LLM は 100 を返すが上書きされる
    });
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    const result = await judgeBook(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as JudgeBookDeps);

    expect(result.score_total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. score_total は 0-100 の範囲に収まる
// ---------------------------------------------------------------------------

describe('judgeBook — score_total 範囲検証', () => {
  it('score_total は 0-100 の範囲に収まる (端値 0)', async () => {
    const text = buildJudgeResponse({
      benefit_clarity: 0,
      logical_consistency: 0,
      style_consistency: 0,
      japanese_naturalness: 0,
      title_alignment: 0,
      genre_fit: 0,
    });
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    const result = await judgeBook(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as JudgeBookDeps);

    expect(result.score_total).toBeGreaterThanOrEqual(0);
    expect(result.score_total).toBeLessThanOrEqual(100);
  });

  it('score_total は 0-100 の範囲に収まる (端値 100)', async () => {
    const text = buildJudgeResponse({
      benefit_clarity: 100,
      logical_consistency: 100,
      style_consistency: 100,
      japanese_naturalness: 100,
      title_alignment: 100,
      genre_fit: 100,
    });
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    const result = await judgeBook(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as JudgeBookDeps);

    expect(result.score_total).toBeGreaterThanOrEqual(0);
    expect(result.score_total).toBeLessThanOrEqual(100);
    expect(result.score_total).toBe(100);
  });

  it('score_total は整数である (切り捨て確認)', async () => {
    // 合計が 6 で割り切れない値で切り捨てを確認: 1+1+1+1+1+0 = 5, Math.floor(5/6) = 0
    const text = buildJudgeResponse({
      benefit_clarity: 1,
      logical_consistency: 1,
      style_consistency: 1,
      japanese_naturalness: 1,
      title_alignment: 1,
      genre_fit: 0,
    });
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    const result = await judgeBook(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as JudgeBookDeps);

    expect(Number.isInteger(result.score_total)).toBe(true);
    expect(result.score_total).toBe(0); // Math.floor(5/6) = 0
  });
});

// ---------------------------------------------------------------------------
// 3. JSON parse 失敗 → AgentError をスロー
// ---------------------------------------------------------------------------

describe('judgeBook — JSON parse 失敗', () => {
  it('不正な JSON テキスト → AgentError(invalid_output)', async () => {
    const fakeClient = makeFakeClient('これは JSON ではありません。Sorry.');
    const loadActivePrompt = makeLoadActivePromptStub();

    let caught: unknown;
    try {
      await judgeBook(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        loadActivePrompt,
      } as JudgeBookDeps);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
  });

  it('score_breakdown を持たない JSON → AgentError(invalid_output)', async () => {
    const fakeClient = makeFakeClient(JSON.stringify({ score_total: 80 }));
    const loadActivePrompt = makeLoadActivePromptStub();

    let caught: unknown;
    try {
      await judgeBook(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        loadActivePrompt,
      } as JudgeBookDeps);
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
      judgeBook(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        loadActivePrompt,
      } as JudgeBookDeps),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it('schema 違反 JSON (軸スコアが文字列) → AgentError(invalid_output: schema validation)', async () => {
    const fakeClient = makeFakeClient(
      JSON.stringify({
        score_total: 80,
        score_breakdown: {
          benefit_clarity: 'high', // 数値であるべき
          logical_consistency: 75,
          style_consistency: 70,
          japanese_naturalness: 85,
          title_alignment: 90,
          genre_fit: 65,
        },
        judge_comments: { overall: 'テスト' },
      }),
    );
    const loadActivePrompt = makeLoadActivePromptStub();

    let caught: unknown;
    try {
      await judgeBook(baseInput(), {
        createAgentClient: vi.fn(async () => fakeClient),
        loadActivePrompt,
      } as JudgeBookDeps);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
  });
});

// ---------------------------------------------------------------------------
// 4. createAgentClient が role='judge' で呼ばれる
// ---------------------------------------------------------------------------

describe('judgeBook — createAgentClient 呼出引数', () => {
  it('createAgentClient が role=judge / ctx.bookId / ctx.jobId を渡される', async () => {
    const input = baseInput({ book_id: 'book-XYZ', job_id: 'job-456' });
    const text = buildJudgeResponse();
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();
    const createSpy: JudgeBookDeps['createAgentClient'] = vi.fn(
      async () => fakeClient,
    );

    await judgeBook(input, {
      createAgentClient: createSpy,
      loadActivePrompt,
    } as JudgeBookDeps);

    const spyMock = createSpy as unknown as { mock: { calls: unknown[][] } };
    expect(spyMock.mock.calls).toHaveLength(1);
    const callArgs = spyMock.mock.calls[0]!;
    // 第 1 引数: role
    expect(callArgs[0]).toBe('judge');
    // 第 2 引数: genre
    expect(callArgs[1]).toBeNull();
    // 第 3 引数: ctx
    const ctx = callArgs[2] as { role: string; bookId: string; jobId?: string };
    expect(ctx).toMatchObject({
      role: 'judge',
      bookId: 'book-XYZ',
      jobId: 'job-456',
    });
  });

  it('createAgentClient が role=judge で呼ばれる (jobId なし)', async () => {
    const input = baseInput({ book_id: 'book-ABC' });
    const text = buildJudgeResponse();
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();
    const createSpy: JudgeBookDeps['createAgentClient'] = vi.fn(
      async () => fakeClient,
    );

    await judgeBook(input, {
      createAgentClient: createSpy,
      loadActivePrompt,
    } as JudgeBookDeps);

    const spyMock = createSpy as unknown as { mock: { calls: unknown[][] } };
    expect(spyMock.mock.calls[0]![0]).toBe('judge');
    const ctx = spyMock.mock.calls[0]![2] as { role: string; bookId: string; jobId?: string };
    expect(ctx.role).toBe('judge');
    expect(ctx.bookId).toBe('book-ABC');
    expect(ctx.jobId).toBeUndefined();
  });

  it('client.complete に role=judge + maxOutputTokens=4096 + system/user が渡る', async () => {
    const text = buildJudgeResponse();
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    await judgeBook(baseInput(), {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as JudgeBookDeps);

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    expect(args.role).toBe('judge');
    expect(args.maxOutputTokens).toBe(4096);
    expect(args.messages).toHaveLength(2);
    expect(args.messages[0]!.role).toBe('system');
    expect(args.messages[1]!.role).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// 5. loadActivePrompt('judge', genre) が呼ばれプレースホルダ差込結果が LLM に渡る
// ---------------------------------------------------------------------------

describe('judgeBook — プロンプト差込', () => {
  it("loadActivePrompt が role='judge' と genre で呼ばれる", async () => {
    const input = baseInput({ genre: 'business' });
    const text = buildJudgeResponse();
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    await judgeBook(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as JudgeBookDeps);

    expect(loadActivePrompt).toHaveBeenCalledTimes(1);
    expect(loadActivePrompt).toHaveBeenCalledWith('judge', 'business', undefined);
  });

  it('プレースホルダ ({theme_title}/{chapter_count}/{draft_chapters}) が system に差し込まれる', async () => {
    const input = baseInput({
      genre: 'practical',
      theme_context: {
        title: 'プレースホルダテスト書籍',
        hook: '独自の切り口',
        target_reader: '初心者向け',
      },
    });
    const text = buildJudgeResponse();
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    await judgeBook(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as JudgeBookDeps);

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    const systemMsg = args.messages.find((m) => m.role === 'system');
    expect(systemMsg!.content).toContain('プレースホルダテスト書籍');
    expect(systemMsg!.content).toContain('practical');
    expect(systemMsg!.content).toContain('2'); // chapter_count
    expect(systemMsg!.content).toContain('"index":1');
  });

  it('genre=null の場合 loadActivePrompt に null が渡される', async () => {
    const input = baseInput({ genre: null });
    const text = buildJudgeResponse();
    const fakeClient = makeFakeClient(text);
    const loadActivePrompt = makeLoadActivePromptStub();

    await judgeBook(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      loadActivePrompt,
    } as JudgeBookDeps);

    expect(loadActivePrompt).toHaveBeenCalledWith('judge', null, undefined);
  });
});
