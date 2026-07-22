/**
 * F-062 — runCostOptimizeWeekly の単体テスト（LLM/prisma を DI）。
 */
import { describe, expect, it, vi } from 'vitest';

import { runCostOptimizeWeekly } from '../src/tasks/cost-optimize-weekly.js';

function buildPrisma(opts: { grouped?: unknown[]; created?: Array<Record<string, unknown>> }) {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    tokenUsage: {
      groupBy: vi.fn(async () => opts.grouped ?? [
        { role: 'writer', provider: 'anthropic', model: 'claude-opus-4-7', _sum: { cost_jpy: 8000, input_tokens: 1000, output_tokens: 2000, image_count: 0 }, _count: { _all: 40 } },
        { role: 'editor', provider: 'anthropic', model: 'claude-opus-4-7', _sum: { cost_jpy: 3000, input_tokens: 500, output_tokens: 800, image_count: 0 }, _count: { _all: 20 } },
      ]),
    },
    modelAssignment: { findMany: vi.fn(async () => [{ role: 'writer', genre: null, provider: 'anthropic', model: 'claude-opus-4-7' }]) },
    modelCatalog: { findMany: vi.fn(async () => [{ provider: 'anthropic', model: 'claude-sonnet-4-6', input_price_per_mtok_usd: 3, output_price_per_mtok_usd: 15, image_price_per_image_usd: null }]) },
    appSettings: { findUnique: vi.fn(async () => ({ promo_dispatch_cron: '*/30 * * * *', promo_daily_review_enabled: true })) },
    costImprovementProposal: {
      updateMany: vi.fn(async () => ({ count: 2 })),
      createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => { created.push(...args.data); return { count: args.data.length }; }),
    },
  };
  return { prisma, created };
}

describe('runCostOptimizeWeekly', () => {
  it('コストを集計しエージェントを呼び、旧提案を supersede して新提案を保存', async () => {
    const { prisma, created } = buildPrisma({});
    const analyze = vi.fn(async () => ({
      proposals: [
        { category: 'model' as const, title: 'editor を Sonnet に', description: '安価化', estimated_saving_jpy: 1500, impact_note: '軽微', action: { kind: 'switch_model_assignment' as const, role: 'editor', genre: null, provider: 'anthropic', model: 'claude-sonnet-4-6' } },
      ],
    }));
    const res = await runCostOptimizeWeekly({}, { prisma: prisma as never, analyze, now: () => new Date('2026-07-22T00:00:00Z'), genId: () => 'batch-1' });
    expect(analyze).toHaveBeenCalledTimes(1);
    // 集計が渡っている
    const input = (analyze.mock.calls[0] as unknown as unknown[])[0] as { total_cost_jpy: number; by_role_model: unknown[] };
    expect(input.total_cost_jpy).toBe(11000);
    expect(res.superseded).toBe(2);
    expect(res.proposals).toBe(1);
    expect(created[0]).toMatchObject({ batch_id: 'batch-1', action_kind: 'switch_model_assignment', status: 'proposed' });
    expect((created[0]!.action_params_json as { model: string }).model).toBe('claude-sonnet-4-6');
  });

  it('コストデータが無ければエージェントを呼ばない', async () => {
    const { prisma } = buildPrisma({ grouped: [] });
    const analyze = vi.fn();
    const res = await runCostOptimizeWeekly({}, { prisma: prisma as never, analyze: analyze as never, now: () => new Date('2026-07-22T00:00:00Z') });
    expect(analyze).not.toHaveBeenCalled();
    expect(res.proposals).toBe(0);
  });

  it('提案0件なら supersede しない', async () => {
    const { prisma } = buildPrisma({});
    const analyze = vi.fn(async () => ({ proposals: [] }));
    const res = await runCostOptimizeWeekly({}, { prisma: prisma as never, analyze, now: () => new Date('2026-07-22T00:00:00Z') });
    expect(res.proposals).toBe(0);
    expect(prisma.costImprovementProposal.updateMany).not.toHaveBeenCalled();
  });
});
