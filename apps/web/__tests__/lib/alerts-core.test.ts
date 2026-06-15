/**
 * alerts-core.ts unit tests (T-07-08, S-028).
 *
 * Tests:
 *  1. mark_read updates read_at for given IDs
 *  2. mark_resolved updates resolved_at for given IDs
 *  3. validation: empty alert_ids fails
 *  4. validation: invalid action fails
 *  5. returns updated count from updateMany
 */
import { describe, expect, it, vi } from 'vitest';

import { isFail, isOk } from '@a2p/contracts';

import {
  markAlertsCore,
  type AlertsDeps,
  type AlertRepo,
} from '../../lib/alerts-core';

const FROZEN_NOW = new Date('2026-05-25T10:00:00.000Z');

function makeDeps(opts: {
  updateManyResult?: { count: number };
} = {}): {
  deps: AlertsDeps;
  spies: {
    updateMany: ReturnType<typeof vi.fn>;
  };
} {
  const updateMany = vi.fn(async () => opts.updateManyResult ?? { count: 0 });

  const alertRepo: AlertRepo = {
    updateMany,
  };

  return {
    deps: {
      alertRepo,
      session: { user: { id: 'user1', username: 'admin' } },
      now: FROZEN_NOW,
    },
    spies: { updateMany },
  };
}

describe('markAlertsCore', () => {
  it('mark_read calls updateMany with read_at', async () => {
    const { deps, spies } = makeDeps({ updateManyResult: { count: 2 } });

    const result = await markAlertsCore(
      { alert_ids: ['a1', 'a2'], action: 'mark_read' },
      deps,
    );

    expect(isOk(result)).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.updated).toBe(2);

    expect(spies.updateMany).toHaveBeenCalledOnce();
    const callArgs = spies.updateMany.mock.calls[0]?.[0] as { where: { id: { in: string[] } }; data: { read_at?: Date; resolved_at?: Date } };
    expect(callArgs.where.id.in).toEqual(['a1', 'a2']);
    expect(callArgs.data.read_at).toEqual(FROZEN_NOW);
    expect(callArgs.data.resolved_at).toBeUndefined();
  });

  it('mark_resolved calls updateMany with resolved_at', async () => {
    const { deps, spies } = makeDeps({ updateManyResult: { count: 3 } });

    const result = await markAlertsCore(
      { alert_ids: ['a1', 'a2', 'a3'], action: 'mark_resolved' },
      deps,
    );

    expect(isOk(result)).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.updated).toBe(3);

    const callArgs = spies.updateMany.mock.calls[0]?.[0] as { data: { read_at?: Date; resolved_at?: Date } };
    expect(callArgs.data.resolved_at).toEqual(FROZEN_NOW);
    expect(callArgs.data.read_at).toBeUndefined();
  });

  it('rejects empty alert_ids', async () => {
    const { deps } = makeDeps();

    const result = await markAlertsCore(
      { alert_ids: [], action: 'mark_read' },
      deps,
    );

    expect(isFail(result)).toBe(true);
    if (result.ok) throw new Error('expected fail');
    expect(result.error.code).toBe('validation');
  });

  it('rejects invalid action', async () => {
    const { deps } = makeDeps();

    const result = await markAlertsCore(
      { alert_ids: ['a1'], action: 'invalid_action' },
      deps,
    );

    expect(isFail(result)).toBe(true);
    if (result.ok) throw new Error('expected fail');
    expect(result.error.code).toBe('validation');
  });

  it('rejects missing fields', async () => {
    const { deps } = makeDeps();

    const result = await markAlertsCore({}, deps);

    expect(isFail(result)).toBe(true);
    if (result.ok) throw new Error('expected fail');
    expect(result.error.code).toBe('validation');
  });

  it('returns 0 updated when no matching alerts', async () => {
    const { deps } = makeDeps({ updateManyResult: { count: 0 } });

    const result = await markAlertsCore(
      { alert_ids: ['nonexistent'], action: 'mark_read' },
      deps,
    );

    expect(isOk(result)).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.updated).toBe(0);
  });
});
