/**
 * F-053 — bakeoff.run worker タスクの単体テスト。
 */
import { describe, expect, it, vi } from 'vitest';

import { runBakeoff } from '../src/tasks/bakeoff-run.js';

type AnyArgs = Record<string, unknown>;

function makeDeps(overrides: {
  run?: Record<string, unknown> | null;
  candidateResults?: Array<Record<string, unknown>>;
  rankings?: Array<Record<string, unknown>>;
}) {
  const created: Array<AnyArgs> = [];
  const updatedResults: Array<AnyArgs> = [];
  const updatedRuns: Array<AnyArgs> = [];
  let seq = 0;
  const prisma = {
    bakeoffRun: {
      findUnique: vi.fn((_a: AnyArgs) => Promise.resolve(overrides.run ?? null)),
      update: vi.fn((a: AnyArgs) => {
        updatedRuns.push(a);
        return Promise.resolve({});
      }),
    },
    bakeoffResult: {
      create: vi.fn((a: AnyArgs) => {
        created.push(a);
        seq += 1;
        return Promise.resolve({ id: `res-${seq}` });
      }),
      update: vi.fn((a: AnyArgs) => {
        updatedResults.push(a);
        return Promise.resolve({});
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const cr = overrides.candidateResults ?? [];
  let ci = 0;
  const runCandidate = vi.fn(() => Promise.resolve(cr[ci++] ?? { provider: 'x', model: 'y', output: 'o' }));
  const rankOutputs = vi.fn(() => Promise.resolve(overrides.rankings ?? []));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { prisma, runCandidate: runCandidate as any, rankOutputs: rankOutputs as any, created, updatedResults, updatedRuns };
}

const RUN = {
  id: 'run-1',
  role: 'writer',
  genre: null,
  input_json: {
    user: 'サンプル入力',
    candidates: [
      { provider: 'anthropic', model: 'claude-opus-4-8' },
      { provider: 'openai', model: 'gpt-5' },
    ],
  },
  status: 'queued',
};

describe('runBakeoff', () => {
  it('各候補を実行し結果を作成、ランキングで rank/score を更新、done にする', async () => {
    const d = makeDeps({
      run: RUN,
      candidateResults: [
        { provider: 'anthropic', model: 'claude-opus-4-8', output: 'A出力', costJpy: 1.2, latencyMs: 3000 },
        { provider: 'openai', model: 'gpt-5', output: 'B出力', costJpy: 0.9, latencyMs: 2500 },
      ],
      rankings: [
        { index: 0, rank: 1, score: 90, rationale: '最良' },
        { index: 1, rank: 2, score: 70, rationale: '次点' },
      ],
    });
    await runBakeoff({ run_id: 'run-1' }, d);

    expect(d.runCandidate).toHaveBeenCalledTimes(2);
    expect(d.created).toHaveLength(2);
    expect(d.created[0]!.data).toMatchObject({ run_id: 'run-1', provider: 'anthropic', output_text: 'A出力' });
    // ランキング反映
    expect(d.updatedResults).toHaveLength(2);
    expect(d.updatedResults[0]!.data).toMatchObject({ rank: 1, quality_score: 90 });
    // 最終 done
    expect(d.updatedRuns.at(-1)!.data).toMatchObject({ status: 'done' });
  });

  it('input_json が不正なら failed', async () => {
    const d = makeDeps({ run: { ...RUN, input_json: { nope: true } } });
    await runBakeoff({ run_id: 'run-1' }, d);
    expect(d.updatedRuns.at(-1)!.data).toMatchObject({ status: 'failed' });
    expect(d.runCandidate).not.toHaveBeenCalled();
  });

  it('出力ゼロ(全失敗)ならランキングをスキップして done', async () => {
    const d = makeDeps({
      run: RUN,
      candidateResults: [
        { provider: 'anthropic', model: 'claude-opus-4-8', error: 'boom' },
        { provider: 'openai', model: 'gpt-5', error: 'boom' },
      ],
    });
    await runBakeoff({ run_id: 'run-1' }, d);
    expect(d.rankOutputs).not.toHaveBeenCalled();
    expect(d.updatedRuns.at(-1)!.data).toMatchObject({ status: 'done' });
  });

  it('run が無ければ NotFoundError', async () => {
    const d = makeDeps({ run: null });
    await expect(runBakeoff({ run_id: 'x' }, d)).rejects.toThrow();
  });
});
