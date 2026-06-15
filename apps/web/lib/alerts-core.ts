/**
 * markAlerts Server Action core logic (T-07-08, S-028).
 *
 * `app/actions/alerts.ts` (SA wrapper) から呼ばれる業務ロジック。
 * 依存は DI で受け取り Vitest でユニットテスト可能にする
 * (comments-core / outlines-core と同パターン)。
 *
 * 仕様根拠:
 *  - docs/05 §4.3.17 markAlerts SA
 *  - docs/04 S-028: BulkMarkButton (既読/resolved)
 */
import { z } from 'zod';

import {
  isA2PError,
  fail,
  ok,
  type ActionResult,
} from '@a2p/contracts';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// zod schema (docs/05 §4.3.17)
// ---------------------------------------------------------------------------

export const MarkAlertsInputSchema = z.object({
  alert_ids: z.array(z.string().min(1)).min(1),
  action: z.enum(['mark_read', 'mark_resolved']),
});
export type MarkAlertsInput = z.infer<typeof MarkAlertsInputSchema>;

export interface MarkAlertsResult {
  updated: number;
}

// ---------------------------------------------------------------------------
// DI boundary
// ---------------------------------------------------------------------------

export interface AlertRepo {
  updateMany(args: {
    where: { id: { in: string[] } };
    data: { read_at?: Date; resolved_at?: Date };
  }): Promise<{ count: number }>;
}

export interface AlertsDeps {
  alertRepo: AlertRepo;
  session: AuthenticatedSession;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function markAlertsCore(
  input: unknown,
  deps: AlertsDeps,
): Promise<ActionResult<MarkAlertsResult>> {
  const parsed = MarkAlertsInputSchema.safeParse(input);
  if (!parsed.success) {
    return fail('validation', messages.alerts.errors.validation, parsed.error.flatten());
  }

  const { alert_ids, action } = parsed.data;
  const now = deps.now ?? new Date();

  try {
    const data: { read_at?: Date; resolved_at?: Date } =
      action === 'mark_read'
        ? { read_at: now }
        : { resolved_at: now };

    const result = await deps.alertRepo.updateMany({
      where: { id: { in: alert_ids } },
      data,
    });

    return ok({ updated: result.count });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.alerts.errors.unknown);
  }
}
