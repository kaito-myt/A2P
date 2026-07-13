import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  runBakeoffCandidate as defaultRunCandidate,
  rankBakeoffOutputs as defaultRankOutputs,
  type BakeoffCandidateResult,
} from '@a2p/agents/bakeoff';
import type { AgentRole, Genre } from '@a2p/contracts/agents';
import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma, Prisma } from '@a2p/db';

/**
 * `bakeoff.run` タスク (F-053)
 *
 * BakeoffRun の候補モデル各々で役割プロンプトを実行し、出力/コスト/レイテンシを
 * BakeoffResult に保存。全出力を comparator でランク付けして rank/score を更新する。
 */

export const BAKEOFF_RUN_TASK_NAME = 'bakeoff.run';

export const BakeoffRunPayloadSchema = z.object({ run_id: z.string().min(1) });

const InputJsonSchema = z.object({
  user: z.string().min(1),
  system_extra: z.string().optional(),
  candidates: z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) })).min(1).max(8),
  /** P4 増分5: org ロールのモデル最適化ラン。完了時に切替提案を起票する。 */
  org_optimize: z.boolean().optional(),
});

export type BakeoffAddJob = (identifier: string, payload: unknown, spec?: Record<string, unknown>) => Promise<unknown>;

export interface BakeoffRunDeps {
  prisma?: typeof defaultPrisma;
  logger?: Logger;
  runCandidate?: typeof defaultRunCandidate;
  rankOutputs?: typeof defaultRankOutputs;
  /** org_optimize ラン完了時に org.bakeoff.recommend を enqueue する。 */
  addJob?: BakeoffAddJob;
}

export async function runBakeoff(payload: unknown, deps: BakeoffRunDeps = {}): Promise<void> {
  const parsed = BakeoffRunPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('bakeoff.run payload が不正です', { details: { issues: parsed.error.issues } });
  }
  const { run_id: runId } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${BAKEOFF_RUN_TASK_NAME}`);
  const prisma = deps.prisma ?? defaultPrisma;
  const runCandidate = deps.runCandidate ?? defaultRunCandidate;
  const rankOutputs = deps.rankOutputs ?? defaultRankOutputs;

  const run = await prisma.bakeoffRun.findUnique({ where: { id: runId } });
  if (!run) throw new NotFoundError(`BakeoffRun not found: ${runId}`, { details: { runId } });
  if (run.status === 'done') {
    log.info({ task: BAKEOFF_RUN_TASK_NAME, runId }, 'already done — skip');
    return;
  }

  const inputParsed = InputJsonSchema.safeParse(run.input_json);
  if (!inputParsed.success) {
    await prisma.bakeoffRun.update({
      where: { id: runId },
      data: { status: 'failed', error: 'input_json が不正です' },
    });
    return;
  }
  const { user, system_extra, candidates } = inputParsed.data;

  await prisma.bakeoffRun.update({ where: { id: runId }, data: { status: 'running', error: null } });

  const role = run.role as AgentRole;
  const genre = (run.genre ?? null) as Genre | null;

  try {
    // 1. 各候補を実行し結果行を作成
    const results: Array<{ id: string; index: number; res: BakeoffCandidateResult }> = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const res = await runCandidate(
        { runId, role, genre, candidate: candidates[i]!, input: { user, ...(system_extra ? { system_extra } : {}) } },
        {},
      );
      const row = await prisma.bakeoffResult.create({
        data: {
          run_id: runId,
          provider: res.provider,
          model: res.model,
          output_text: res.output ?? null,
          cost_jpy: res.costJpy != null ? new Prisma.Decimal(res.costJpy) : null,
          latency_ms: res.latencyMs ?? null,
          error: res.error ?? null,
        },
      });
      results.push({ id: row.id, index: i, res });
    }

    // 2. 出力できた候補をランク付け
    const scored = results.filter((r) => r.res.output && !r.res.error);
    if (scored.length > 0) {
      let rankings: Awaited<ReturnType<typeof rankOutputs>> = [];
      try {
        rankings = await rankOutputs({
          role,
          genre,
          input: { user, ...(system_extra ? { system_extra } : {}) },
          outputs: scored.map((r) => ({ index: r.index, output: r.res.output! })),
        }, {});
      } catch (rankErr) {
        log.warn({ task: BAKEOFF_RUN_TASK_NAME, runId, err: rankErr }, 'ranking failed — results kept unranked');
      }
      for (const rk of rankings) {
        const target = results.find((r) => r.index === rk.index);
        if (!target) continue;
        await prisma.bakeoffResult.update({
          where: { id: target.id },
          data: { rank: rk.rank, quality_score: rk.score, rationale: rk.rationale },
        });
      }
    }

    await prisma.bakeoffRun.update({ where: { id: runId }, data: { status: 'done', error: null } });
    log.info({ task: BAKEOFF_RUN_TASK_NAME, runId, candidates: candidates.length }, 'bakeoff done');

    // P4 増分5: org モデル最適化ランは、完了後に切替提案(org.bakeoff.recommend)へ連鎖。
    if (inputParsed.data.org_optimize && deps.addJob) {
      try {
        await deps.addJob('org.bakeoff.recommend', { run_id: runId }, { maxAttempts: 3 });
      } catch (enqErr) {
        log.warn({ task: BAKEOFF_RUN_TASK_NAME, runId, err: enqErr }, 'failed to enqueue org.bakeoff.recommend');
      }
    }
  } catch (err) {
    await prisma.bakeoffRun.update({
      where: { id: runId },
      data: { status: 'failed', error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) },
    });
    throw err;
  }
}

export const bakeoffRunTask: Task = async (payload: unknown, helpers: JobHelpers) => {
  await runBakeoff(payload, { addJob: helpers.addJob as unknown as BakeoffAddJob });
};
