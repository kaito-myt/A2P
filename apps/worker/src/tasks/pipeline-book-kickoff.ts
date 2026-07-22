import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  acquireBookLock as defaultAcquireBookLock,
  releaseBookLock as defaultReleaseBookLock,
} from '@a2p/agents/lib/book-lock';
import { loadModelAssignment as defaultLoadModelAssignment } from '@a2p/agents/lib/load-model-assignment';
import { loadActivePrompt as defaultLoadActivePrompt } from '@a2p/agents/lib/prompt-loader';
import type { AgentRole, Genre } from '@a2p/contracts/agents';
import { GENRE_SLUGS } from '@a2p/contracts/agents';
import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import {
  notifyJobChange as defaultNotifyJobChange,
  type JobChangeNotifyPayload,
} from '../lib/notify-job-change.js';

/**
 * `pipeline.book.kickoff` タスク (docs/05 §5.3.1, F-010)
 *
 * 採用 `ThemeCandidate` を起点に `Book` 行を作成し、その時点の `ModelAssignment` /
 * `Prompt` active 版を `Book.model_assignment_snapshot` / `Book.prompt_version_ids_json`
 * へ凍結する。続いて `pipeline.book.marketer` を子 enqueue する。
 *
 * フロー (docs/05 §5.2 共通ポリシー + §13 #5 冪等性 + T-03-04 教訓):
 *   1. payload zod parse (theme_id / account_id / job_id, optional batch_plan_item_id / overrides)
 *   2. 内部 `Job` 行を CAS で `running` に更新。既に `done` ならスキップ。
 *   3. `ThemeCandidate` を読み出し、genre を解決。既に `Book` を作成済み (= Job.book_id) なら
 *      その Book を再利用 (再実行冪等性)。未作成なら snapshot を確定して `Book` INSERT。
 *   3-b. `Book` 作成直後に `Job.book_id` を即座に確定 (retry idempotency 用)。
 *        後段失敗で retry された次の attempt が `existingJob.book_id` 経由で Book を流用し、
 *        二重作成を防ぐ (docs/05 §13 #5)。
 *   4. `BookLock` 取得 (holder=pipeline:<job_id>, TTL 30 分) — kickoff は短時間だが防御。
 *   5. `ThemeCandidate.status='accepted'` + `decided_at=now()` に遷移 (未確定なら)。
 *   6. `BatchPlanItem.book_id` を紐付け (payload にあれば)。
 *   7. `pipeline.book.marketer` 用の **内部 `Job` 行を新規 INSERT** し、その新規 Job.id を
 *      payload に乗せて graphile-worker へ enqueue (parent_job_id=<kickoff jobId>)。
 *   8. kickoff Job を done に遷移 (result_json: { book_id, marketer_job_id })。
 *   9. finally で BookLock 解放。
 *
 * エラー方針 (T-03-04 と同形):
 *   - payload zod 違反 → ValidationError
 *   - ThemeCandidate / 内部 Job 不在 → NotFoundError
 *   - loadModelAssignment が ConfigError (役割の active 行欠落) → 透過 throw
 *   - Book.create / lock 取得失敗 → 透過 throw + Job=failed 降格 (graphile-worker retry)
 *   - CAS で running 化した後の失敗は finally で BookLock 解放 + Job=failed
 */

export const PIPELINE_BOOK_KICKOFF_TASK_NAME = 'pipeline.book.kickoff';

/** docs/05 §5.3.1 — payload schema (placeholder と互換)。 */
export const PipelineBookKickoffPayloadSchema = z.object({
  theme_id: z.string().min(1),
  account_id: z.string().min(1),
  job_id: z.string().min(1),
  batch_plan_item_id: z.string().min(1).optional(),
  model_assignment_overrides: z
    .record(
      z.string(),
      z.object({ provider: z.string().min(1), model: z.string().min(1) }),
    )
    .optional(),
});

export type PipelineBookKickoffPayload = z.infer<typeof PipelineBookKickoffPayloadSchema>;

/** snapshot に並べる順序 — 7 役 (revision は除く: revision-run は別系で snapshot しない)。 */
export const SNAPSHOT_ROLES = [
  'marketer',
  'writer',
  'editor',
  'judge',
  'thumbnail_text',
  'thumbnail_image',
  'optimizer',
] as const satisfies readonly AgentRole[];

const ALLOWED_GENRES = new Set<string>(GENRE_SLUGS);

/** snapshot 1 役 = { provider, model }。docs/05 §3 Book.model_assignment_snapshot 互換。 */
export interface ModelAssignmentSnapshotEntry {
  provider: string;
  model: string;
}
export type ModelAssignmentSnapshot = Record<string, ModelAssignmentSnapshotEntry>;

/** AppSettings.ab_distribution_json の 1 エントリ (T-11-06)。 */
export interface AbDistributionConfigEntry {
  role: string;
  genre: string;
  baseline_id: string;
  candidate_id: string;
  ratio_candidate: number;
}

/** Prisma 部分 I/F — テストで mock しやすいよう最小サブセット。 */
export interface PipelineBookKickoffPrisma {
  /** SSE 進捗配信用 `pg_notify` を `notifyJobChange` 経由で発火するため (T-03-11). */
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
  appSettings: {
    findUnique: (args: {
      where: { id: string };
      select: { ab_distribution_json: true };
    }) => Promise<{ ab_distribution_json: unknown } | null>;
  };
  job: {
    findUnique: (args: {
      where: { id: string };
      select: { status: true; book_id: true };
    }) => Promise<{ status: string; book_id: string | null } | null>;
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
        book_id?: string | null;
      };
    }) => Promise<unknown>;
    create: (args: {
      data: {
        kind: string;
        book_id: string;
        parent_job_id: string;
        status: string;
        payload_json: unknown;
      };
    }) => Promise<{ id: string }>;
  };
  themeCandidate: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        account_id: true;
        genre: true;
        title: true;
        subtitle: true;
        status: true;
      };
    }) => Promise<{
      id: string;
      account_id: string;
      genre: string;
      title: string;
      subtitle: string | null;
      status: string;
    } | null>;
    update: (args: {
      where: { id: string };
      data: { status?: string; decided_at?: Date };
    }) => Promise<unknown>;
  };
  book: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        account_id: true;
        theme_id: true;
        title: true;
        subtitle: true;
      };
    }) => Promise<{
      id: string;
      account_id: string;
      theme_id: string | null;
      title: string;
      subtitle: string | null;
    } | null>;
    create: (args: {
      data: {
        account_id: string;
        theme_id: string;
        title: string;
        subtitle: string | null;
        status: string;
        model_assignment_snapshot: unknown;
        prompt_version_ids_json: unknown;
        cost_jpy_total: number;
      };
    }) => Promise<{ id: string }>;
  };
  batchPlanItem: {
    update: (args: {
      where: { id: string };
      data: { book_id?: string; status?: string };
    }) => Promise<unknown>;
  };
}

/** `helpers.addJob` の最小 I/F — テスト時は mock を差し込む。 */
export type AddJobLike = (
  identifier: string,
  payload: unknown,
  spec?: Record<string, unknown>,
) => Promise<unknown>;

export interface PipelineBookKickoffDeps {
  prisma?: PipelineBookKickoffPrisma;
  logger?: Logger;
  loadModelAssignment?: typeof defaultLoadModelAssignment;
  loadActivePrompt?: typeof defaultLoadActivePrompt;
  acquireLock?: typeof defaultAcquireBookLock;
  releaseLock?: typeof defaultReleaseBookLock;
  now?: () => Date;
  /**
   * A/B 配信で使う乱数 (0..1)。DI で決定的にテスト可能にする (T-11-06)。
   * 省略時は Math.random()。
   */
  rand?: () => number;
  /**
   * SSE 進捗配信用 `pg_notify` (T-03-11, docs/05 §1.4).
   * 失敗しても本処理は継続. テストでは noop もしくは spy を渡す.
   */
  notifyJobChange?: (
    payload: JobChangeNotifyPayload,
    deps: { prisma: { $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number> }; logger?: Logger },
  ) => Promise<{ ok: boolean }>;
}

/**
 * graphile-worker から呼ばれる Task 本体は下の `pipelineBookKickoffTask`。
 * このヘルパは DI を受け取りテストから直接呼べる。
 */
export async function runPipelineBookKickoff(
  payload: unknown,
  addJob: AddJobLike,
  deps: PipelineBookKickoffDeps = {},
): Promise<void> {
  const parsed = PipelineBookKickoffPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('pipeline.book.kickoff payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const {
    theme_id: themeId,
    account_id: accountId,
    job_id: jobId,
    batch_plan_item_id: batchPlanItemId,
    model_assignment_overrides: overrides,
  } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PIPELINE_BOOK_KICKOFF_TASK_NAME}`);
  const prisma =
    deps.prisma ?? (defaultPrisma as unknown as PipelineBookKickoffPrisma);
  const loadModelAssignmentFn = deps.loadModelAssignment ?? defaultLoadModelAssignment;
  const loadActivePromptFn = deps.loadActivePrompt ?? defaultLoadActivePrompt;
  const acquireLock = deps.acquireLock ?? defaultAcquireBookLock;
  const releaseLock = deps.releaseLock ?? defaultReleaseBookLock;
  const notifyJobChangeFn = deps.notifyJobChange ?? defaultNotifyJobChange;
  const now = deps.now ?? (() => new Date());
  const randFn = deps.rand ?? (() => Math.random());

  // 1. 冪等性チェック: 既に done なら skip (docs/05 §13 #5)
  const existingJob = await prisma.job.findUnique({
    where: { id: jobId },
    select: { status: true, book_id: true },
  });
  if (!existingJob) {
    throw new NotFoundError(`Job not found: ${jobId}`, {
      details: { jobId, themeId, accountId },
    });
  }
  if (existingJob.status === 'done') {
    log.info(
      { task: PIPELINE_BOOK_KICKOFF_TASK_NAME, jobId, themeId, accountId },
      'job already done — skipping (idempotent)',
    );
    return;
  }

  // 2. CAS で queued/failed → running。レースで他 worker が先に running 化していたら skip。
  const casResult = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ['queued', 'failed'] } },
    data: { status: 'running', started_at: now() },
  });
  if (casResult.count === 0) {
    log.info(
      {
        task: PIPELINE_BOOK_KICKOFF_TASK_NAME,
        jobId,
        themeId,
        observedStatus: existingJob.status,
      },
      'job not in queued/failed state — skipping (probably already running on another worker)',
    );
    return;
  }

  let acquiredBookId: string | null = null;

  try {
    // 3. ThemeCandidate fetch
    const theme = await prisma.themeCandidate.findUnique({
      where: { id: themeId },
      select: {
        id: true,
        account_id: true,
        genre: true,
        title: true,
        subtitle: true,
        status: true,
      },
    });
    if (!theme) {
      throw new NotFoundError(`ThemeCandidate not found: ${themeId}`, {
        details: { themeId, jobId, accountId },
      });
    }

    const genre = normalizeGenre(theme.genre);

    // 4. Book を確定 — 再実行で Job.book_id が既にあればその Book を流用 (= snapshot 再生成しない)。
    //    初回は model_assignment / prompt snapshot を確定して Book INSERT。
    let book: { id: string; account_id: string };
    if (existingJob.book_id) {
      const existingBook = await prisma.book.findUnique({
        where: { id: existingJob.book_id },
        select: {
          id: true,
          account_id: true,
          theme_id: true,
          title: true,
          subtitle: true,
        },
      });
      if (!existingBook) {
        throw new NotFoundError(
          `Job.book_id refers to non-existent Book: ${existingJob.book_id}`,
          { details: { jobId, bookId: existingJob.book_id } },
        );
      }
      book = { id: existingBook.id, account_id: existingBook.account_id };
      log.info(
        { task: PIPELINE_BOOK_KICKOFF_TASK_NAME, jobId, bookId: book.id },
        're-running kickoff for existing Book (idempotent retry)',
      );
    } else {
      const modelSnapshot = await buildModelAssignmentSnapshot({
        loadModelAssignment: loadModelAssignmentFn,
        genre,
        overrides,
      });
      const promptSnapshot = await buildPromptVersionSnapshot({
        loadActivePrompt: loadActivePromptFn,
        genre,
      });

      // A/B 配信: AppSettings.ab_distribution_json を参照し、設定がある role は
      // 乱数で baseline/candidate どちらかの prompt_id を上書きする (T-11-06)。
      await applyAbDistribution({
        promptSnapshot,
        genre,
        prisma,
        randFn,
        log,
      });

      const created = await prisma.book.create({
        data: {
          account_id: accountId,
          theme_id: theme.id,
          title: theme.title,
          subtitle: theme.subtitle,
          status: 'queued',
          model_assignment_snapshot: modelSnapshot,
          prompt_version_ids_json: promptSnapshot,
          cost_jpy_total: 0,
        },
      });
      // Book 作成直後に Job.book_id を確定 (docs/05 §13 #5 冪等性ルール準拠)。
      // 後段失敗 (lock/theme update/child enqueue) → retry 時に existingJob.book_id 経由で
      // Book を流用でき、二重作成を防ぐ。
      await prisma.job.update({
        where: { id: jobId },
        data: { book_id: created.id },
      });
      book = { id: created.id, account_id: accountId };
      log.info(
        {
          task: PIPELINE_BOOK_KICKOFF_TASK_NAME,
          jobId,
          bookId: book.id,
          themeId,
          genre,
          snapshotRoles: Object.keys(modelSnapshot),
          overrideRoles: overrides ? Object.keys(overrides) : [],
        },
        'Book created with frozen model_assignment / prompt snapshot',
      );
    }

    // 5. BookLock 取得 (kickoff の短時間処理だが、子 enqueue 直後に marketer が
    //    同じ book を触り始めるため、念のため取得 → 即解放する)。
    await acquireLock({
      bookId: book.id,
      holder: `pipeline:${jobId}`,
      ttlMinutes: 30,
    });
    acquiredBookId = book.id;

    // 6. ThemeCandidate.status='accepted' に遷移 (未確定のみ)
    if (theme.status !== 'accepted') {
      await prisma.themeCandidate.update({
        where: { id: theme.id },
        data: { status: 'accepted', decided_at: now() },
      });
    }

    // 7. BatchPlanItem を紐付け (あれば)
    if (batchPlanItemId) {
      try {
        await prisma.batchPlanItem.update({
          where: { id: batchPlanItemId },
          data: { book_id: book.id, status: 'kicked' },
        });
      } catch (bpiErr) {
        // BatchPlanItem は cron 起動経路でのみ存在。手動 kick では欠落しうるため warn 継続。
        log.warn(
          { task: PIPELINE_BOOK_KICKOFF_TASK_NAME, jobId, batchPlanItemId, err: bpiErr },
          'failed to bind BatchPlanItem.book_id — continuing',
        );
      }
    }

    // 8. 子 Job (pipeline.book.marketer) を INSERT → addJob
    //    子 Job.id を payload に乗せる (親 jobId 流用禁止 — T-03-04 教訓)。
    const childPayload = { book_id: book.id } as const;
    const marketerJob = await prisma.job.create({
      data: {
        kind: 'pipeline.book.marketer',
        book_id: book.id,
        parent_job_id: jobId,
        status: 'queued',
        payload_json: childPayload,
      },
    });
    await addJob(
      'pipeline.book.marketer',
      { book_id: book.id, job_id: marketerJob.id },
      { maxAttempts: 3 },
    );

    // 9. kickoff Job を done に遷移
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        finished_at: now(),
        error: null,
        result_json: {
          book_id: book.id,
          marketer_job_id: marketerJob.id,
        },
      },
    });

    // 10. SSE 進捗配信用に pg_notify (T-03-11, docs/05 §1.4 / ADR-001).
    //     失敗しても本処理に影響させない (notifyJobChange 内で warn 済).
    await notifyJobChangeFn(
      {
        jobId,
        status: 'done',
        kind: PIPELINE_BOOK_KICKOFF_TASK_NAME,
        bookId: book.id,
      },
      { prisma, logger: log },
    );

    log.info(
      {
        task: PIPELINE_BOOK_KICKOFF_TASK_NAME,
        jobId,
        bookId: book.id,
        marketerJobId: marketerJob.id,
        batchPlanItemId,
      },
      'pipeline.book.kickoff done — marketer enqueued',
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
        { task: PIPELINE_BOOK_KICKOFF_TASK_NAME, jobId, err: jobUpdateErr },
        'failed to mark internal Job as failed',
      );
    }
    throw err;
  } finally {
    if (acquiredBookId) {
      try {
        await releaseLock({ bookId: acquiredBookId, holder: `pipeline:${jobId}` });
      } catch (releaseErr) {
        log.warn(
          { task: PIPELINE_BOOK_KICKOFF_TASK_NAME, jobId, bookId: acquiredBookId, err: releaseErr },
          'failed to release BookLock (will be swept by locks.sweep)',
        );
      }
    }
  }
}

/**
 * 7 役分の active ModelAssignment を引いて snapshot を作る。
 * `overrides` があれば該当役を上書きする。一役でも欠落していれば `loadModelAssignment` が
 * `ConfigError` を throw し、ここから透過する。
 */
async function buildModelAssignmentSnapshot(args: {
  loadModelAssignment: typeof defaultLoadModelAssignment;
  genre: Genre | null;
  overrides: Record<string, { provider: string; model: string }> | undefined;
}): Promise<ModelAssignmentSnapshot> {
  const snapshot: ModelAssignmentSnapshot = {};
  for (const role of SNAPSHOT_ROLES) {
    const override = args.overrides?.[role];
    if (override) {
      snapshot[role] = { provider: override.provider, model: override.model };
      continue;
    }
    const loaded = await args.loadModelAssignment(role, args.genre);
    snapshot[role] = { provider: loaded.provider, model: loaded.model };
  }
  return snapshot;
}

/**
 * 7 役分の active Prompt を引いて prompt_version_ids snapshot を作る。
 * Prompt 未シード等で見つからなければ `loadActivePrompt` が `ConfigError` を throw する。
 */
async function buildPromptVersionSnapshot(args: {
  loadActivePrompt: typeof defaultLoadActivePrompt;
  genre: Genre | null;
}): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const role of SNAPSHOT_ROLES) {
    const loaded = await args.loadActivePrompt(role, args.genre);
    snapshot[role] = loaded.promptId;
  }
  return snapshot;
}

/**
 * AppSettings.ab_distribution_json を参照し、設定がある role の prompt_id を
 * 乱数 (randFn) で baseline/candidate のどちらかに上書きする (T-11-06)。
 * 設定がない role は既存 active prompt_id のまま。
 * DB 読み込み失敗時は warn を出して既存値を保持し処理を継続する。
 */
async function applyAbDistribution(args: {
  promptSnapshot: Record<string, string>;
  genre: Genre | null;
  prisma: Pick<PipelineBookKickoffPrisma, 'appSettings'>;
  randFn: () => number;
  log: Logger;
}): Promise<void> {
  const { promptSnapshot, genre, prisma, randFn, log } = args;

  let abList: AbDistributionConfigEntry[] = [];
  try {
    const row = await prisma.appSettings.findUnique({
      where: { id: 'singleton' },
      select: { ab_distribution_json: true },
    });
    abList = parseAbDistributionJson(row?.ab_distribution_json);
  } catch (err) {
    log.warn(
      { task: PIPELINE_BOOK_KICKOFF_TASK_NAME, err },
      'failed to load ab_distribution_json — using active prompts as-is',
    );
    return;
  }

  const genreStr = normalizeAbGenre(genre);
  for (const entry of abList) {
    if (entry.genre !== genreStr) continue;
    if (!(entry.role in promptSnapshot)) continue;
    const rand = randFn();
    const selectedId = rand < entry.ratio_candidate ? entry.candidate_id : entry.baseline_id;
    promptSnapshot[entry.role] = selectedId;
    log.info(
      {
        task: PIPELINE_BOOK_KICKOFF_TASK_NAME,
        role: entry.role,
        genre: entry.genre,
        rand,
        ratio_candidate: entry.ratio_candidate,
        selected: rand < entry.ratio_candidate ? 'candidate' : 'baseline',
        prompt_id: selectedId,
      },
      'A/B distribution applied for role',
    );
  }
}

function parseAbDistributionJson(raw: unknown): AbDistributionConfigEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is AbDistributionConfigEntry => {
    if (typeof v !== 'object' || v === null) return false;
    const o = v as Record<string, unknown>;
    return (
      typeof o.role === 'string' &&
      typeof o.genre === 'string' &&
      typeof o.baseline_id === 'string' &&
      typeof o.candidate_id === 'string' &&
      typeof o.ratio_candidate === 'number'
    );
  });
}

/** DB の genre 文字列を AgentRole 入力 enum に正規化 (未知値は null fallback)。 */
function normalizeGenre(g: string): Genre | null {
  return ALLOWED_GENRES.has(g) ? (g as Genre) : null;
}

/**
 * A/B 配信保存キーの genre 正規化。null（ジャンル非指定）→ 'default'。
 * web/lib/ab-distribution-core.ts の normalizeAbGenre と同一規約 (パッケージ境界のためコピー)。
 */
function normalizeAbGenre(genre: Genre | null): string {
  return genre ?? 'default';
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
export const pipelineBookKickoffTask: Task = async (
  payload: unknown,
  helpers: JobHelpers,
) => {
  await runPipelineBookKickoff(
    payload,
    helpers.addJob as unknown as AddJobLike,
  );
};
