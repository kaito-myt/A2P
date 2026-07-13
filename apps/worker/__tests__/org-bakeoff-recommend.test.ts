import { describe, expect, it, vi } from 'vitest';

import {
  runOrgBakeoffRecommend,
  type OrgBakeoffRecommendPrisma,
  type OrgBakeoffRecommendDeps,
} from '../src/tasks/org-bakeoff-recommend.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as OrgBakeoffRecommendDeps['logger'];

interface Opts {
  role?: string;
  results: Array<{ provider: string; model: string; quality_score: number | null; cost_jpy: unknown; error: string | null }>;
  current?: { provider: string; model: string } | null;
}

function makeHarness(o: Opts) {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    bakeoffRun: {
      findUnique: vi.fn(async () => ({ role: o.role ?? 'ceo', genre: null, status: 'done' })),
    },
    bakeoffResult: {
      findMany: vi.fn(async () => o.results),
    },
    modelAssignment: {
      findFirst: vi.fn(async () => o.current ?? null),
    },
    orgTask: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: `t-${created.length}` };
      }),
    },
  } as unknown as OrgBakeoffRecommendPrisma;
  return { prisma, created };
}

const deps = (prisma: OrgBakeoffRecommendPrisma): OrgBakeoffRecommendDeps => ({ prisma, logger: silentLogger });

describe('runOrgBakeoffRecommend', () => {
  it('現行より良いモデルがあれば optimize_model(needs_human) を起票', async () => {
    const { prisma, created } = makeHarness({
      current: { provider: 'anthropic', model: 'opus' },
      results: [
        { provider: 'anthropic', model: 'opus', quality_score: 80, cost_jpy: 10, error: null },
        { provider: 'anthropic', model: 'sonnet', quality_score: 92, cost_jpy: 3, error: null },
      ],
    });
    const res = await runOrgBakeoffRecommend({ run_id: 'run-1' }, deps(prisma));
    expect(res.is_change).toBe(true);
    expect(res.task_id).toBeTruthy();
    expect(created[0]!.kind).toBe('optimize_model');
    expect(created[0]!.status).toBe('needs_human');
    const rj = created[0]!.result_json as { proposal: { model: string } };
    expect(rj.proposal.model).toBe('sonnet');
  });

  it('現行が最良なら提案を起票しない', async () => {
    const { prisma, created } = makeHarness({
      current: { provider: 'anthropic', model: 'opus' },
      results: [
        { provider: 'anthropic', model: 'opus', quality_score: 95, cost_jpy: 10, error: null },
        { provider: 'anthropic', model: 'sonnet', quality_score: 70, cost_jpy: 3, error: null },
      ],
    });
    const res = await runOrgBakeoffRecommend({ run_id: 'run-1' }, deps(prisma));
    expect(res.is_change).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('使える結果が無ければ提案なし', async () => {
    const { prisma, created } = makeHarness({
      results: [{ provider: 'a', model: 'b', quality_score: null, cost_jpy: null, error: 'boom' }],
    });
    const res = await runOrgBakeoffRecommend({ run_id: 'run-1' }, deps(prisma));
    expect(res.recommended).toBe(false);
    expect(created).toHaveLength(0);
  });
});
