/**
 * `optimizer.prompt.generate` ワーカータスク本実装 (docs/05 §5.3.11, F-009, SP-11 T-11-02)
 *
 * フロー:
 *   A. payload zod parse (ValidationError)
 *   B. 冪等性チェック: Job.status='done' なら skip
 *   C. CAS: queued/failed → running
 *   D. role/genre 未指定 → 直近 10 冊 eval_results を集計して最低スコア role×genre を自動選択
 *   E. active prompt (role, genre) 取得 → なければ ConfigError + Job=failed
 *   F. 直近 10 冊 eval_results (current prompt_version_id 一致) + sales_records 取得
 *   G. optimizePrompt() 呼出 (LoggingContext: role='optimizer', jobId=job_id, bookId=null)
 *   H. PromptProposal INSERT (status='pending')
 *   I. Job.status='done', result_json に proposal_id
 *   J. notifyJobChange (ADR-001: channel='jobs')
 *
 * エラー方針:
 *   - payload zod 違反 → ValidationError
 *   - Job not found → NotFoundError
 *   - active prompt 不在 → ConfigError (Job=failed 降格)
 *   - optimizePrompt AgentError / ProviderError → 透過 throw + Job=failed
 *   - notifyJobChange 失敗 → warn のみで継続
 */
import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import { optimizePrompt as defaultOptimizePrompt } from '@a2p/agents/optimizer';
import type { OptimizerInput, OptimizerOutput } from '@a2p/contracts/agents/optimizer';
import { ConfigError, NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import {
  notifyJobChange as defaultNotifyJobChange,
  type JobChangeNotifyPayload,
} from '../lib/notify-job-change.js';
import {
  performAutoApproval,
  type AutoApprovalPrisma,
} from '../lib/auto-approval.js';

export const OPTIMIZER_PROMPT_GENERATE_TASK_NAME = 'optimizer.prompt.generate';

export const OptimizerPromptGeneratePayloadSchema = z.object({
  trigger: z.enum(['cron_10_books', 'manual']),
  role: z
    .enum(['marketer', 'writer', 'editor', 'judge', 'thumbnail_text', 'optimizer'])
    .optional(),
  genre: z.string().optional(),
  job_id: z.string(),
});
export type OptimizerPromptGeneratePayload = z.infer<typeof OptimizerPromptGeneratePayloadSchema>;

/** Prisma 最小サブセット I/F — テストで mock しやすいよう定義。 */
export interface OptimizerPromptGeneratePrisma {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
  job: {
    findUnique: (args: {
      where: { id: string };
      select: { status: true };
    }) => Promise<{ status: string } | null>;
    updateMany: (args: {
      where: { id: string; status: { in: string[] } };
      data: { status: string; started_at?: Date };
    }) => Promise<{ count: number }>;
    update: (args: {
      where: { id: string };
      data: {
        status?: string;
        finished_at?: Date;
        error?: string | null;
        result_json?: unknown;
      };
    }) => Promise<unknown>;
  };
  prompt: {
    findFirst: (args: {
      where: { role: string; genre: string | null; status: string };
      select: { id: true; body: true; version: true };
      orderBy: { version: 'desc' };
    }) => Promise<{ id: string; body: string; version: number } | null>;
  };
  promptProposal: {
    create: (args: {
      data: {
        source_prompt_id: string;
        role: string;
        genre: string | null;
        proposed_body: string;
        diff: string;
        rationale: string;
        expected_effect_json: unknown;
        sample_output?: string | null;
        status: string;
      };
    }) => Promise<{ id: string }>;
  };
  evalResult: {
    findMany: (args: {
      where: { prompt_version_ids_json?: unknown };
      select: {
        id: true;
        book_id: true;
        score_total: true;
        score_breakdown_json: true;
        prompt_version_ids_json: true;
      };
      orderBy: { judged_at: 'desc' };
      take: number;
    }) => Promise<
      Array<{
        id: string;
        book_id: string;
        score_total: number;
        score_breakdown_json: unknown;
        prompt_version_ids_json: unknown;
      }>
    >;
  };
  salesRecord: {
    findMany: (args: {
      where: { book_id: { in: string[] } };
      select: { book_id: true; royalty_jpy: true; avg_stars: true };
      orderBy: { fetched_at: 'desc' };
    }) => Promise<
      Array<{
        book_id: string;
        royalty_jpy: number;
        avg_stars: { toNumber: () => number } | number | null;
      }>
    >;
  };
}

/** `helpers.addJob` の最小 I/F. */
export type AddJobLike = (
  identifier: string,
  payload: unknown,
  spec?: Record<string, unknown>,
) => Promise<unknown>;

export interface OptimizerPromptGenerateDeps {
  prisma?: OptimizerPromptGeneratePrisma;
  logger?: Logger;
  optimizePrompt?: (input: OptimizerInput) => Promise<OptimizerOutput>;
  now?: () => Date;
  notifyJobChange?: (
    payload: JobChangeNotifyPayload,
    deps: {
      prisma: { $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number> };
      logger?: Logger;
    },
  ) => Promise<{ ok: boolean }>;
  /**
   * T-11-05: 自動承認判定関数 DI。
   * テスト時は `async () => ({ shouldAutoApprove: false })` 等で上書き可能。
   * 省略時は false を返すスタブ（生成直後は 0 冊で条件不成立のため）。
   * 実際の自動承認判定は T-11-03 (pipeline-book-export フック) で本物を注入する設計。
   */
  checkAutoApprovalFn?: (
    proposalId: string,
    deps?: { prisma?: AutoApprovalPrisma; now?: () => Date },
  ) => Promise<{ shouldAutoApprove: boolean; rollback_until?: Date }>;
}

/**
 * graphile-worker から呼ばれる Task 本体は下の `optimizerPromptGenerateTask`.
 * このヘルパは DI を受け取りテストから直接呼べる.
 */
export async function runOptimizerPromptGenerate(
  payload: unknown,
  _addJob: AddJobLike,
  deps: OptimizerPromptGenerateDeps = {},
): Promise<void> {
  const parsed = OptimizerPromptGeneratePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('optimizer.prompt.generate payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }

  const { trigger, role: payloadRole, genre: payloadGenre, job_id: jobId } = parsed.data;

  const log =
    deps.logger ?? createLogger(`worker.${OPTIMIZER_PROMPT_GENERATE_TASK_NAME}`);
  const prisma =
    deps.prisma ?? (defaultPrisma as unknown as OptimizerPromptGeneratePrisma);
  const optimizePromptFn = deps.optimizePrompt ?? defaultOptimizePrompt;
  const notifyJobChangeFn = deps.notifyJobChange ?? defaultNotifyJobChange;
  const now = deps.now ?? (() => new Date());
  // T-11-05: 省略時は false スタブ（生成直後 0 冊のため通常 false）
  const checkAutoApprovalFn = deps.checkAutoApprovalFn ?? (async () => ({ shouldAutoApprove: false as const }));

  // A. 冪等性チェック: 既に done なら skip
  const existing = await prisma.job.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  if (!existing) {
    throw new NotFoundError(`Job not found: ${jobId}`, {
      details: { jobId },
    });
  }
  if (existing.status === 'done') {
    log.info(
      { task: OPTIMIZER_PROMPT_GENERATE_TASK_NAME, jobId, trigger },
      'job already done — skipping (idempotent)',
    );
    return;
  }

  // B. CAS: queued/failed → running
  const casResult = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ['queued', 'failed'] } },
    data: { status: 'running', started_at: now() },
  });
  if (casResult.count === 0) {
    log.info(
      { task: OPTIMIZER_PROMPT_GENERATE_TASK_NAME, jobId, observedStatus: existing.status },
      'job not in queued/failed state — skipping (probably already running on another worker)',
    );
    return;
  }

  try {
    // C. role/genre 未指定 → 直近 10 冊の eval_results から最低スコア role×genre を自動選択
    let targetRole: string;
    let targetGenre: string | null;

    if (payloadRole !== undefined) {
      // manual 指定
      targetRole = payloadRole;
      targetGenre = payloadGenre ?? null;

      log.info(
        { task: OPTIMIZER_PROMPT_GENERATE_TASK_NAME, jobId, trigger, targetRole, targetGenre },
        'role/genre specified manually',
      );
    } else {
      // 自動選択: 直近 10 冊 eval_results を全件取得してアプリ層で集計
      const allRecentEvals = await prisma.evalResult.findMany({
        where: {},
        select: {
          id: true,
          book_id: true,
          score_total: true,
          score_breakdown_json: true,
          prompt_version_ids_json: true,
        },
        orderBy: { judged_at: 'desc' },
        take: 10,
      });

      if (allRecentEvals.length === 0) {
        // eval_results がまだない場合は writer/null (デフォルト) にフォールバック
        targetRole = 'writer';
        targetGenre = null;
        log.info(
          { task: OPTIMIZER_PROMPT_GENERATE_TASK_NAME, jobId },
          'no eval_results found — falling back to writer/null',
        );
      } else {
        // role×genre 別にスコア平均を計算して最低を選択
        // prompt_version_ids_json = Record<role, prompt_id>
        const roleGenreScores: Map<string, { totalScore: number; count: number; genre: string | null }> =
          new Map();

        for (const evalRow of allRecentEvals) {
          const pvIds = evalRow.prompt_version_ids_json as Record<string, string>;
          // eval_results の prompt_version_ids_json のキーが role に対応
          for (const role of Object.keys(pvIds)) {
            // genre はこのコンテキストでは不明（book の theme から取得が必要だが、
            // ここでは role 単位で集計する（genre=null の汎用プロンプト対象）
            const key = `${role}:null`;
            const entry = roleGenreScores.get(key);
            if (entry) {
              entry.totalScore += evalRow.score_total;
              entry.count += 1;
            } else {
              roleGenreScores.set(key, { totalScore: evalRow.score_total, count: 1, genre: null });
            }
          }
        }

        // 最低平均スコアの role を選択
        let lowestAvg = Infinity;
        let lowestRole = 'writer';
        let lowestGenre: string | null = null;

        for (const [key, stats] of roleGenreScores.entries()) {
          const avg = stats.totalScore / stats.count;
          if (avg < lowestAvg) {
            lowestAvg = avg;
            const colonIdx = key.indexOf(':');
            lowestRole = key.slice(0, colonIdx);
            lowestGenre = stats.genre;
          }
        }

        targetRole = lowestRole;
        targetGenre = lowestGenre;

        log.info(
          {
            task: OPTIMIZER_PROMPT_GENERATE_TASK_NAME,
            jobId,
            targetRole,
            targetGenre,
            lowestAvgScore: lowestAvg,
            evalCount: allRecentEvals.length,
          },
          'auto-selected lowest-score role×genre',
        );
      }
    }

    // D. active prompt (role, genre) 取得 → なければ ConfigError
    const activePrompt = await prisma.prompt.findFirst({
      where: { role: targetRole, genre: targetGenre, status: 'active' },
      select: { id: true, body: true, version: true },
      orderBy: { version: 'desc' },
    });

    if (!activePrompt) {
      const configErr = new ConfigError(
        `active プロンプトが見つかりません: role=${targetRole}, genre=${String(targetGenre)}`,
        { details: { role: targetRole, genre: targetGenre, jobId } },
      );
      // Job=failed 降格してから throw
      try {
        await prisma.job.update({
          where: { id: jobId },
          data: {
            status: 'failed',
            finished_at: now(),
            error: `${configErr.name}: ${configErr.message}`,
          },
        });
      } catch (jobUpdateErr) {
        log.warn(
          { task: OPTIMIZER_PROMPT_GENERATE_TASK_NAME, jobId, err: jobUpdateErr },
          'failed to mark Job as failed after ConfigError',
        );
      }
      throw configErr;
    }

    // E. 直近 10 冊の eval_results (current prompt version に一致する範囲) を取得
    //    prompt_version_ids_json が JSON カラムのため、アプリ層でフィルタする
    const recentEvals = await prisma.evalResult.findMany({
      where: {},
      select: {
        id: true,
        book_id: true,
        score_total: true,
        score_breakdown_json: true,
        prompt_version_ids_json: true,
      },
      orderBy: { judged_at: 'desc' },
      take: 10,
    });

    // current prompt version で絞り込み（prompt_version_ids_json[targetRole] === activePrompt.id）
    const filteredEvals = recentEvals.filter((e) => {
      const pvIds = e.prompt_version_ids_json as Record<string, string>;
      return pvIds[targetRole] === activePrompt.id;
    });

    // F. 対象 book_id の sales_records 取得
    const bookIds = [...new Set(filteredEvals.map((e) => e.book_id))];
    const salesRows = bookIds.length > 0
      ? await prisma.salesRecord.findMany({
          where: { book_id: { in: bookIds } },
          select: { book_id: true, royalty_jpy: true, avg_stars: true },
          orderBy: { fetched_at: 'desc' },
        })
      : [];

    // book 単位で最新 salesRecord に絞り込み
    const latestSalesByBook: Map<string, { book_id: string; royalty_jpy: number; avg_stars: number | null }> =
      new Map();
    for (const s of salesRows) {
      if (!latestSalesByBook.has(s.book_id)) {
        const avgStars =
          s.avg_stars == null
            ? null
            : typeof s.avg_stars === 'object' && 'toNumber' in s.avg_stars
              ? (s.avg_stars as { toNumber: () => number }).toNumber()
              : Number(s.avg_stars);
        latestSalesByBook.set(s.book_id, {
          book_id: s.book_id,
          royalty_jpy: s.royalty_jpy,
          avg_stars: avgStars,
        });
      }
    }

    // G. OptimizerInput 構築
    const recentEvalsInput: OptimizerInput['recent_evals'] = filteredEvals.map((e) => {
      const pvIds = e.prompt_version_ids_json as Record<string, string>;
      return {
        book_id: e.book_id,
        score_total: e.score_total,
        score_breakdown: e.score_breakdown_json as Record<string, number>,
        prompt_version_id: pvIds[targetRole] ?? activePrompt.id,
      };
    });

    const recentSalesInput: OptimizerInput['recent_sales'] = [...latestSalesByBook.values()];

    const optimizerInput: OptimizerInput = {
      role: targetRole,
      genre: targetGenre,
      job_id: jobId,
      recent_evals: recentEvalsInput,
      recent_sales: recentSalesInput,
      current_prompt: {
        id: activePrompt.id,
        body: activePrompt.body,
        version: activePrompt.version,
      },
    };

    log.info(
      {
        task: OPTIMIZER_PROMPT_GENERATE_TASK_NAME,
        jobId,
        targetRole,
        targetGenre,
        evalCount: recentEvalsInput.length,
        salesCount: recentSalesInput.length,
        promptId: activePrompt.id,
        promptVersion: activePrompt.version,
      },
      'calling optimizePrompt',
    );

    // H. optimizePrompt 呼出 (token_usage は内部で role='optimizer', book_id=null で INSERT)
    const optimizerOutput = await optimizePromptFn(optimizerInput);

    // I. PromptProposal INSERT (status='pending')
    const proposal = await prisma.promptProposal.create({
      data: {
        source_prompt_id: activePrompt.id,
        role: targetRole,
        genre: targetGenre,
        proposed_body: optimizerOutput.proposed_body,
        diff: optimizerOutput.diff,
        rationale: optimizerOutput.rationale,
        expected_effect_json: optimizerOutput.expected_effect,
        sample_output: optimizerOutput.sample_output ?? null,
        status: 'pending',
      },
    });

    log.info(
      {
        task: OPTIMIZER_PROMPT_GENERATE_TASK_NAME,
        jobId,
        proposalId: proposal.id,
        role: targetRole,
        genre: targetGenre,
      },
      'PromptProposal INSERT complete',
    );

    // J. Job.status='done', result_json に proposal_id
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        finished_at: now(),
        error: null,
        result_json: {
          proposal_id: proposal.id,
          role: targetRole,
          genre: targetGenre,
          trigger,
          prompt_id: activePrompt.id,
          prompt_version: activePrompt.version,
        },
      },
    });

    log.info(
      { task: OPTIMIZER_PROMPT_GENERATE_TASK_NAME, jobId, proposalId: proposal.id },
      'optimizer.prompt.generate done',
    );

    // K. SSE 進捗配信 (ADR-001: channel='jobs')
    await notifyJobChangeFn(
      {
        jobId,
        status: 'done',
        kind: OPTIMIZER_PROMPT_GENERATE_TASK_NAME,
        phase: 'proposal_created',
      },
      { prisma, logger: log },
    );

    // L. T-11-05: 自動承認判定フック
    // 生成直後 (0 冊時点) は通常 false。T-11-03 の pipeline-book-export フックで
    // 5 冊蓄積後に再評価される設計。省略時は false スタブを使用。
    const proposalId = proposal.id;
    const approvalCheck = await checkAutoApprovalFn(proposalId, {
      prisma: prisma as unknown as AutoApprovalPrisma,
      now,
    });
    if (approvalCheck.shouldAutoApprove && approvalCheck.rollback_until) {
      log.info(
        { task: OPTIMIZER_PROMPT_GENERATE_TASK_NAME, jobId, proposalId },
        'auto-approval condition met — executing auto-approve flow',
      );
      try {
        // proposal から role/genre を取得（直前の INSERT データを再利用）
        await performAutoApproval(
          proposalId,
          {
            role: targetRole,
            genre: targetGenre,
            proposedBody: optimizerOutput.proposed_body,
            rollbackUntil: approvalCheck.rollback_until,
            now: now(),
          },
          prisma as unknown as AutoApprovalPrisma,
        );
        log.info(
          { task: OPTIMIZER_PROMPT_GENERATE_TASK_NAME, jobId, proposalId },
          'auto-approval complete',
        );
      } catch (autoApproveErr) {
        // 自動承認失敗は warn のみで継続 (proposal は pending のまま手動承認へ)
        log.warn(
          { task: OPTIMIZER_PROMPT_GENERATE_TASK_NAME, jobId, proposalId, err: autoApproveErr },
          'auto-approval flow failed — proposal remains pending',
        );
      }
    }
  } catch (err) {
    // ConfigError は上で既に Job=failed 降格済みなのでスキップ
    if (!(err instanceof ConfigError)) {
      try {
        await prisma.job.update({
          where: { id: jobId },
          data: {
            status: 'failed',
            finished_at: now(),
            error: serializeError(err),
          },
        });
      } catch (jobUpdateErr) {
        log.warn(
          { task: OPTIMIZER_PROMPT_GENERATE_TASK_NAME, jobId, err: jobUpdateErr },
          'failed to mark Job as failed',
        );
      }
    }
    throw err;
  }
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** graphile-worker 用エクスポート. `buildTaskList()` から登録される. */
export const optimizerPromptGenerateTask: Task = async (
  payload: unknown,
  helpers: JobHelpers,
) => {
  await runOptimizerPromptGenerate(
    payload,
    helpers.addJob as unknown as AddJobLike,
  );
};

