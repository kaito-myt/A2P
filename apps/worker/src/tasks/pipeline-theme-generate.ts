import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import { generateMarketerThemes as defaultGenerateMarketerThemes } from '@a2p/agents/marketer';
import type {
  MarketerThemeInput,
  MarketerThemeOutput,
  ThemeCandidate as MarketerThemeCandidate,
} from '@a2p/contracts/agents/marketer';
import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

/**
 * `pipeline.theme.generate` タスク (T-03-06, F-001).
 *
 * `actions/themes.ts` から enqueue される単発 worker タスク。
 * Marketer エージェントでテーマ候補を生成し、`ThemeCandidate` テーブルに一括 INSERT する。
 *
 * フロー (docs/05 §5.2 共通ポリシー + §13 #5 冪等性 + T-03-04/05 教訓):
 *   1. payload zod parse (theme_session_id / job_id)
 *   2. 内部 `Job` を `findUnique` で取得。既に `done` ならスキップ。
 *   3. CAS で queued/failed → running に上げる。レース敗者は skip。
 *   4. Job.payload_json から生成パラメタ (account_id / genre / keyword_or_brief / count /
 *      exclude_titles_recent) を読み出す (payload 不変性保持)。
 *   5. exclude_titles_recent が未指定なら DB から直近 90 日の
 *      `theme_candidates.status IN ('accepted')` のタイトルを集計。
 *   6. `generateMarketerThemes({ themeSessionId, jobId (= 内部 Job.id), ... })` 呼出。
 *   7. 結果を `ThemeCandidate.createMany` で一括 INSERT
 *      (account_id / theme_session_id / genre / title / hook / target_reader /
 *      competitors_json / signals_json / status='pending')
 *   8. Job を `done` に遷移 (result_json: { theme_session_id, candidate_count })
 *
 * エラー方針 (T-03-04 と同形):
 *   - payload zod 違反 → `ValidationError`
 *   - Job 不在 / Job.payload_json 不正 → `ValidationError`/`NotFoundError`
 *   - Marketer / DB 失敗 → 透過 throw + Job=failed 降格 (graphile-worker retry)
 *   - 子 enqueue は無し (テーマ生成は単発で、後段は UI からの承認 → kickoff 経由)。
 */

export const PIPELINE_THEME_GENERATE_TASK_NAME = 'pipeline.theme.generate';

/** graphile-worker payload (最小)。 */
export const PipelineThemeGeneratePayloadSchema = z.object({
  theme_session_id: z.string().min(1),
  job_id: z.string().min(1),
});
export type PipelineThemeGeneratePayload = z.infer<
  typeof PipelineThemeGeneratePayloadSchema
>;

/** Job.payload_json から復元する SA 投入時の生成パラメタ。 */
const JobPayloadSchema = z.object({
  theme_session_id: z.string().min(1),
  account_id: z.string().min(1),
  genre: z.enum(['practical', 'business', 'self_help']).nullable(),
  keyword_or_brief: z.string().min(1).max(500),
  count: z.number().int().min(1).max(30),
  exclude_titles_recent: z.array(z.string()).max(500).optional(),
  // テーマ作成時に選択した著者名/レーベル名マスタ (任意)。生成候補全件に付与。
  author_name_id: z.string().nullish(),
  label_name_id: z.string().nullish(),
});
export type JobPayloadShape = z.infer<typeof JobPayloadSchema>;

/** Prisma 部分 I/F — テストで mock しやすいよう最小サブセット。 */
export interface PipelineThemeGeneratePrisma {
  job: {
    findUnique: (args: {
      where: { id: string };
      select: { status: true; payload_json: true };
    }) => Promise<{ status: string; payload_json: unknown } | null>;
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
  themeCandidate: {
    findMany: (args: {
      where: {
        account_id: string;
        status: { in: string[] };
        decided_at?: { gte: Date };
      };
      select: { title: true };
      take?: number;
    }) => Promise<Array<{ title: string }>>;
    createMany: (args: {
      data: Array<{
        account_id: string;
        theme_session_id: string;
        genre: string;
        title: string;
        subtitle: string | null;
        hook: string;
        target_reader: string | null;
        competitors_json: unknown;
        signals_json: unknown;
        status: string;
      }>;
    }) => Promise<{ count: number }>;
  };
}

export interface PipelineThemeGenerateDeps {
  prisma?: PipelineThemeGeneratePrisma;
  logger?: Logger;
  generateThemes?: typeof defaultGenerateMarketerThemes;
  now?: () => Date;
  /** 直近採用済タイトル集計の対象日数 (既定 90 日)。 */
  excludeLookbackDays?: number;
}

const DEFAULT_LOOKBACK_DAYS = 90;
const EXCLUDE_TITLES_HARD_LIMIT = 500;

/**
 * graphile-worker から呼ばれる Task 本体は下の `pipelineThemeGenerateTask`。
 * このヘルパは DI を受け取りテストから直接呼べる。
 */
export async function runPipelineThemeGenerate(
  payload: unknown,
  deps: PipelineThemeGenerateDeps = {},
): Promise<void> {
  const parsed = PipelineThemeGeneratePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('pipeline.theme.generate payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const { theme_session_id: themeSessionId, job_id: jobId } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PIPELINE_THEME_GENERATE_TASK_NAME}`);
  const prisma =
    deps.prisma ?? (defaultPrisma as unknown as PipelineThemeGeneratePrisma);
  const generateThemes = deps.generateThemes ?? defaultGenerateMarketerThemes;
  const now = deps.now ?? (() => new Date());
  const lookbackDays = deps.excludeLookbackDays ?? DEFAULT_LOOKBACK_DAYS;

  // 1. 冪等性チェック: 既に done なら skip
  const existing = await prisma.job.findUnique({
    where: { id: jobId },
    select: { status: true, payload_json: true },
  });
  if (!existing) {
    throw new NotFoundError(`Job not found: ${jobId}`, {
      details: { jobId, themeSessionId },
    });
  }
  if (existing.status === 'done') {
    log.info(
      { task: PIPELINE_THEME_GENERATE_TASK_NAME, jobId, themeSessionId },
      'job already done — skipping (idempotent)',
    );
    return;
  }

  // 2. CAS で queued/failed → running
  const casResult = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ['queued', 'failed'] } },
    data: { status: 'running', started_at: now() },
  });
  if (casResult.count === 0) {
    log.info(
      {
        task: PIPELINE_THEME_GENERATE_TASK_NAME,
        jobId,
        themeSessionId,
        observedStatus: existing.status,
      },
      'job not in queued/failed state — skipping',
    );
    return;
  }

  try {
    // 3. Job.payload_json から生成パラメタ復元
    const jobPayloadParsed = JobPayloadSchema.safeParse(existing.payload_json);
    if (!jobPayloadParsed.success) {
      throw new ValidationError(
        'pipeline.theme.generate Job.payload_json が不正です',
        { details: { issues: jobPayloadParsed.error.issues, jobId } },
      );
    }
    const jobPayload = jobPayloadParsed.data;
    if (jobPayload.theme_session_id !== themeSessionId) {
      throw new ValidationError(
        'theme_session_id mismatch between payload and Job.payload_json',
        {
          details: {
            payloadThemeSessionId: themeSessionId,
            jobPayloadThemeSessionId: jobPayload.theme_session_id,
            jobId,
          },
        },
      );
    }

    // 4. exclude_titles_recent: 明示指定が無ければ直近 90 日 accepted を集計
    const excludeTitlesRecent =
      jobPayload.exclude_titles_recent !== undefined
        ? jobPayload.exclude_titles_recent
        : await fetchRecentAcceptedTitles({
            prisma,
            accountId: jobPayload.account_id,
            lookbackDays,
            now: now(),
          });

    // 5. Marketer エージェント呼出
    //    jobId は内部 Job.id (cuid) を渡す (T-03-04 教訓: FK 違反回避)。
    const marketerInput: MarketerThemeInput = {
      themeSessionId,
      accountId: jobPayload.account_id,
      jobId,
      genre: jobPayload.genre,
      keywordOrBrief: jobPayload.keyword_or_brief,
      excludeTitlesRecent,
      count: jobPayload.count,
    };
    const result: MarketerThemeOutput = await generateThemes(marketerInput);

    // 6. ThemeCandidate.createMany — schema column 名と整合 (snake_case)
    const candidateRows = result.candidates.map((c) =>
      mapCandidateToRow({
        candidate: c,
        accountId: jobPayload.account_id,
        themeSessionId,
        genre: jobPayload.genre,
        authorNameId: jobPayload.author_name_id ?? null,
        labelNameId: jobPayload.label_name_id ?? null,
      }),
    );
    const inserted = await prisma.themeCandidate.createMany({
      data: candidateRows,
    });

    // 7. Job done
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        finished_at: now(),
        error: null,
        result_json: {
          theme_session_id: themeSessionId,
          candidate_count: inserted.count,
          notes: result.notes ?? null,
        },
      },
    });

    log.info(
      {
        task: PIPELINE_THEME_GENERATE_TASK_NAME,
        jobId,
        themeSessionId,
        candidateCount: inserted.count,
      },
      'pipeline.theme.generate done — ThemeCandidates inserted',
    );
  } catch (err) {
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
        { task: PIPELINE_THEME_GENERATE_TASK_NAME, jobId, themeSessionId, err: jobUpdateErr },
        'failed to mark internal Job as failed',
      );
    }
    throw err;
  }
}

/**
 * 直近 N 日以内に accepted となった `theme_candidates.title` を最大
 * EXCLUDE_TITLES_HARD_LIMIT 件取得する。Marketer に「避けるリスト」として渡す。
 */
async function fetchRecentAcceptedTitles(args: {
  prisma: PipelineThemeGeneratePrisma;
  accountId: string;
  lookbackDays: number;
  now: Date;
}): Promise<string[]> {
  const since = new Date(args.now.getTime() - args.lookbackDays * 24 * 60 * 60 * 1000);
  const rows = await args.prisma.themeCandidate.findMany({
    where: {
      account_id: args.accountId,
      status: { in: ['accepted'] },
      decided_at: { gte: since },
    },
    select: { title: true },
    take: EXCLUDE_TITLES_HARD_LIMIT,
  });
  return rows.map((r) => r.title);
}

/** Marketer の `ThemeCandidate` (camelCase) を DB schema 列 (snake_case) にマッピング。 */
function mapCandidateToRow(args: {
  candidate: MarketerThemeCandidate;
  accountId: string;
  themeSessionId: string;
  genre: 'practical' | 'business' | 'self_help' | null;
  authorNameId?: string | null;
  labelNameId?: string | null;
}): {
  account_id: string;
  theme_session_id: string;
  genre: string;
  title: string;
  subtitle: string | null;
  hook: string;
  target_reader: string | null;
  author_name_id: string | null;
  label_name_id: string | null;
  competitors_json: unknown;
  signals_json: unknown;
  status: string;
} {
  return {
    account_id: args.accountId,
    theme_session_id: args.themeSessionId,
    // DB.theme_candidates.genre は NOT NULL string。genre が null の場合は 'practical'
    // を fallback とする (UI 側で必ず指定させる前提だが、防御的に既定値を設定)。
    genre: args.genre ?? 'practical',
    title: args.candidate.title,
    subtitle: args.candidate.subtitle ?? null,
    hook: args.candidate.hook,
    target_reader: args.candidate.target_reader ?? null,
    // テーマ作成時に選択した著者名/レーベル名を全候補に付与 (未選択なら null)。
    author_name_id: args.authorNameId ?? null,
    label_name_id: args.labelNameId ?? null,
    competitors_json: args.candidate.competitors,
    signals_json: args.candidate.signals,
    status: 'pending',
  };
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** graphile-worker 用エクスポート。`buildTaskList()` から登録される。 */
export const pipelineThemeGenerateTask: Task = async (
  payload: unknown,
  _helpers: JobHelpers,
) => {
  await runPipelineThemeGenerate(payload);
};
