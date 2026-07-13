'use server';

/**
 * docs/06 — 組織エージェント (経営) の Server Actions。
 *
 * - runOrgPlan: CEO ティック (org.plan) を enqueue し、全社状況から方針＋ToDoを自動起票させる。
 * - approve/complete/cancel OrgTask: 全社ToDoボードの人手操作。
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isA2PError, fail, ok, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { enqueueJob } from '@/lib/graphile-client';
import { messages } from '@/lib/messages';

const ORG_PLAN_TASK = 'org.plan';
const ORG_EXECUTE_TASK = 'org.execute.dispatch';
const ORG_OPS_WATCH_TASK = 'org.ops.watch';
const ORG_FINANCE_TICK_TASK = 'org.finance.tick';
const ORG_KDP_SCREEN_TASK = 'org.kdp.screen';

function revalidateOrg(): void {
  revalidatePath('/org');
  revalidatePath('/org/tasks');
}

export async function runOrgPlan(): Promise<ActionResult<{ job_id: string }>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.org.dashboard.runError);
  }

  try {
    // 既に走っている org.plan があれば二重起動しない。
    const existing = await prisma.job.findFirst({
      where: { kind: ORG_PLAN_TASK, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    let jobId = existing?.id ?? null;
    if (!jobId) {
      const job = await prisma.job.create({
        data: { kind: ORG_PLAN_TASK, status: 'queued', payload_json: { trigger: 'manual' } },
      });
      jobId = job.id;
      await enqueueJob(ORG_PLAN_TASK, { job_id: jobId, trigger: 'manual' });
    }
    revalidateOrg();
    return ok({ job_id: jobId });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.org.dashboard.runError);
  }
}

export async function runOrgDispatch(): Promise<ActionResult<{ job_id: string }>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.org.dashboard.runError);
  }

  try {
    // 既に走っている dispatch があれば二重起動しない。
    const existing = await prisma.job.findFirst({
      where: { kind: ORG_EXECUTE_TASK, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    let jobId = existing?.id ?? null;
    if (!jobId) {
      const job = await prisma.job.create({
        data: { kind: ORG_EXECUTE_TASK, status: 'queued', payload_json: { trigger: 'manual' } },
      });
      jobId = job.id;
      await enqueueJob(ORG_EXECUTE_TASK, { job_id: jobId, trigger: 'manual' });
    }
    revalidateOrg();
    return ok({ job_id: jobId });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.org.dashboard.runError);
  }
}

/** dedup + enqueue の共通処理（org.plan/dispatch/ops.watch/finance.tick 共用）。 */
async function runOrgTick(taskName: string): Promise<ActionResult<{ job_id: string }>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.org.dashboard.runError);
  }

  try {
    const existing = await prisma.job.findFirst({
      where: { kind: taskName, status: { in: ['queued', 'running'] } },
      select: { id: true },
    });
    let jobId = existing?.id ?? null;
    if (!jobId) {
      const job = await prisma.job.create({
        data: { kind: taskName, status: 'queued', payload_json: { trigger: 'manual' } },
      });
      jobId = job.id;
      await enqueueJob(taskName, { job_id: jobId, trigger: 'manual' });
    }
    revalidateOrg();
    return ok({ job_id: jobId });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.org.dashboard.runError);
  }
}

/** docs/06 P3: 運用の自己復旧監視 (org.ops.watch) を手動起動。 */
export async function runOrgOpsWatch(): Promise<ActionResult<{ job_id: string }>> {
  return runOrgTick(ORG_OPS_WATCH_TASK);
}

/** docs/06 P3: 経営の予算ガード (org.finance.tick) を手動起動。 */
export async function runOrgFinanceTick(): Promise<ActionResult<{ job_id: string }>> {
  return runOrgTick(ORG_FINANCE_TICK_TASK);
}

/** docs/06 P4 増分3: KDP 公開の事前スクリーニング (org.kdp.screen) を手動起動。 */
export async function runOrgKdpScreen(): Promise<ActionResult<{ job_id: string }>> {
  return runOrgTick(ORG_KDP_SCREEN_TASK);
}

const TaskIdSchema = z.object({ task_id: z.string().min(1) });

async function transitionTask(
  input: unknown,
  next: 'approved' | 'done' | 'canceled',
): Promise<ActionResult<{ task_id: string; status: string }>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.org.board.actionError);
  }

  const parsed = TaskIdSchema.safeParse(input);
  if (!parsed.success) return fail('validation', messages.org.board.actionError);
  const { task_id } = parsed.data;

  try {
    const task = await prisma.orgTask.findUnique({ where: { id: task_id }, select: { id: true } });
    if (!task) return fail('not_found', messages.org.board.actionError);

    await prisma.orgTask.update({
      where: { id: task_id },
      data: {
        status: next,
        ...(next === 'done' ? { done_at: new Date() } : {}),
      },
    });
    revalidateOrg();
    return ok({ task_id, status: next });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.org.board.actionError);
  }
}

export async function approveOrgTask(input: unknown) {
  return transitionTask(input, 'approved');
}

export async function completeOrgTask(input: unknown) {
  return transitionTask(input, 'done');
}

export async function cancelOrgTask(input: unknown) {
  return transitionTask(input, 'canceled');
}
