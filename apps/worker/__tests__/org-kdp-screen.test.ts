import { describe, expect, it, vi } from 'vitest';

import { runOrgKdpScreen, type OrgKdpScreenPrisma, type OrgKdpScreenDeps } from '../src/tasks/org-kdp-screen.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as OrgKdpScreenDeps['logger'];

interface Opts {
  gate: boolean;
  taskStatus?: string;
  book?: { status: string; publish_status: string; has_blocking_comments: boolean } | null;
  score?: number | null;
  meta?: { price_jpy: number | null; description: string | null; keywords: string[] } | null;
}

function makeHarness(o: Opts) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const prisma = {
    appSettings: {
      findUnique: vi.fn(async () => ({
        org_kdp_auto_publish_enabled: o.gate,
        org_kdp_min_quality: 70,
        org_kdp_min_price_jpy: 250,
        org_kdp_max_price_jpy: 1250,
      })),
    },
    orgTask: {
      findMany: vi.fn(async () => [{ id: 'task1', book_id: 'b1', status: o.taskStatus ?? 'needs_human' }]),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: args.where.id, data: args.data });
        return {};
      }),
    },
    book: {
      findUnique: vi.fn(async () =>
        o.book === undefined
          ? { status: 'done', publish_status: 'unlisted', has_blocking_comments: false }
          : o.book,
      ),
    },
    evalResult: {
      findFirst: vi.fn(async () => (o.score === undefined ? { score_total: 82 } : o.score == null ? null : { score_total: o.score })),
    },
    kdpMetadata: {
      findUnique: vi.fn(async () =>
        o.meta === undefined ? { price_jpy: 500, description: '紹介文' + 'x'.repeat(100), keywords: ['a', 'b', 'c'] } : o.meta,
      ),
    },
    job: { update: vi.fn(async () => ({})) },
  } as unknown as OrgKdpScreenPrisma;
  return { prisma, updates };
}

const deps = (prisma: OrgKdpScreenPrisma): OrgKdpScreenDeps => ({
  prisma,
  logger: silentLogger,
  now: () => new Date('2026-07-13T00:00:00Z'),
});

describe('runOrgKdpScreen', () => {
  it('ゲートOFF: 合格でも承認済へ前進せず advisory 記録のみ', async () => {
    const { prisma, updates } = makeHarness({ gate: false });
    const res = await runOrgKdpScreen({}, deps(prisma));
    expect(res.eligible).toBe(1);
    expect(res.cleared).toBe(0);
    const data = updates[0]!.data;
    expect(data.status).toBeUndefined(); // status 変更なし
    expect((data.result_json as { kdp_readiness: { eligible: boolean } }).kdp_readiness.eligible).toBe(true);
  });

  it('ゲートON + 合格: needs_human → approved（公開クリア）', async () => {
    const { prisma, updates } = makeHarness({ gate: true });
    const res = await runOrgKdpScreen({}, deps(prisma));
    expect(res.cleared).toBe(1);
    expect(updates[0]!.data.status).toBe('approved');
  });

  it('ゲートON でも品質未達なら承認しない（理由記録）', async () => {
    const { prisma, updates } = makeHarness({ gate: true, score: 50 });
    const res = await runOrgKdpScreen({}, deps(prisma));
    expect(res.eligible).toBe(0);
    expect(res.cleared).toBe(0);
    expect(updates[0]!.data.status).toBeUndefined();
    const rd = (updates[0]!.data.result_json as { kdp_readiness: { eligible: boolean; reasons: string[] } }).kdp_readiness;
    expect(rd.eligible).toBe(false);
    expect(rd.reasons.some((x) => x.includes('品質'))).toBe(true);
  });

  it('価格帯外は不可', async () => {
    const { prisma } = makeHarness({ gate: true, meta: { price_jpy: 5000, description: 'x'.repeat(50), keywords: ['a'] } });
    const res = await runOrgKdpScreen({}, deps(prisma));
    expect(res.cleared).toBe(0);
  });
});
