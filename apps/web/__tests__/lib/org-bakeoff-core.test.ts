import { describe, expect, it, vi } from 'vitest';

import { launchOrgModelBakeoffCore, type OrgBakeoffDeps } from '@/lib/org-bakeoff-core';

function makeDeps(o: {
  current?: { provider: string; model: string } | null;
  catalog?: Array<{ provider: string; model: string }>;
}) {
  const runsCreated: Array<Record<string, unknown>> = [];
  const enqueued: Array<{ task: string; payload: unknown }> = [];
  const deps: OrgBakeoffDeps = {
    assignmentRepo: { findFirst: vi.fn(async () => o.current ?? null) },
    catalogRepo: { findMany: vi.fn(async () => o.catalog ?? []) },
    bakeoffRunRepo: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        runsCreated.push(args.data);
        return { id: `run-${runsCreated.length}` };
      }),
    },
    session: { user: { id: 'u1' } },
    enqueue: vi.fn(async (task, payload) => {
      enqueued.push({ task, payload });
    }),
  };
  return { deps, runsCreated, enqueued };
}

describe('launchOrgModelBakeoffCore', () => {
  it('現行＋カタログから候補を組み BakeoffRun 作成＋bakeoff.run enqueue', async () => {
    const { deps, runsCreated, enqueued } = makeDeps({
      current: { provider: 'anthropic', model: 'opus' },
      catalog: [
        { provider: 'anthropic', model: 'opus' }, // 現行と重複 → 除外
        { provider: 'anthropic', model: 'sonnet' },
        { provider: 'openai', model: 'gpt-5' },
      ],
    });
    const res = await launchOrgModelBakeoffCore({ role: 'ceo' }, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.candidates).toBe(3); // opus + sonnet + gpt-5
    const data = runsCreated[0]! as { role: string; input_json: { org_optimize: boolean; candidates: unknown[] } };
    expect(data.role).toBe('ceo');
    expect(data.input_json.org_optimize).toBe(true);
    expect(data.input_json.candidates).toHaveLength(3);
    expect(enqueued[0]).toEqual({ task: 'bakeoff.run', payload: { run_id: 'run-1' } });
  });

  it('org ロールでなければ validation エラー', async () => {
    const { deps } = makeDeps({ current: { provider: 'a', model: 'b' }, catalog: [{ provider: 'c', model: 'd' }] });
    const res = await launchOrgModelBakeoffCore({ role: 'writer' }, deps);
    expect(res.ok).toBe(false);
  });

  it('候補が2未満なら失敗（比較不能）', async () => {
    const { deps, enqueued } = makeDeps({ current: { provider: 'a', model: 'b' }, catalog: [] });
    const res = await launchOrgModelBakeoffCore({ role: 'ceo' }, deps);
    expect(res.ok).toBe(false);
    expect(enqueued).toHaveLength(0);
  });
});
