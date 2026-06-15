/**
 * Themes Server Action のコアロジック (T-03-06, F-001).
 *
 * `app/actions/themes.ts` (SA ラッパ) から呼ばれる業務ロジック。
 * 依存 (prisma / enqueueJob / session / now / genId) は全て DI で受け取り、
 * Vitest で純粋にユニットテスト可能にする (api-credentials-core / model-catalog-core
 * と同パターン)。
 *
 * 仕様根拠:
 *  - docs/05 §4.3.3 `generateThemes` SA
 *  - docs/05 §6.3.1 Marketer (theme)
 *  - docs/05 §14 #6 `theme_session_id` は cuid (Marketer 起動時に発行)
 *  - docs/02 F-001 受入基準
 *
 * フロー:
 *  1. 入力 zod 検証
 *  2. account 存在チェック (FK 違反前に明示)
 *  3. `theme_session_id` を生成 (crypto.randomUUID で衝突回避)
 *  4. 内部 `Job` 行を INSERT (`kind='pipeline.theme.generate'`, `book_id=null`,
 *     payload に theme_session_id + 生成パラメタ一式)
 *  5. graphile-worker へ `pipeline.theme.generate` を enqueue (payload に
 *     `{ theme_session_id, job_id }` のみ。worker 側で Job.payload_json から
 *     残りの生成パラメタを読む)
 *  6. audit_log に `theme_session.generate` を INSERT
 *  7. `{ session_id, job_id }` を返す
 *
 * NOTE: `ThemeSession` という独立モデルは Prisma schema に存在しない
 * (docs/05 §3 を確認)。`theme_session_id` は `theme_candidates.theme_session_id` /
 * `token_usage.theme_session_id` で参照される **キーのみ** の概念で、テーブル化されない
 * (集計用途のみのため)。
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  NotFoundError,
  ValidationError,
  isA2PError,
  fail,
  ok,
  type ActionResult,
} from '@a2p/contracts';
import { Prisma, type Account, type Job, type ThemeCandidate } from '@a2p/db';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// zod schemas — docs/05 §4.3.3 + Marketer 入力契約 (packages/contracts/agents/marketer)
// ---------------------------------------------------------------------------

/**
 * `generateThemes` の入力 schema。
 *
 * docs/05 §4.3.3 は `{ account_id, genres[], count }` だが、
 * F-001 受入基準で「ユーザー入力キーワード/ブリーフから複数のテーマ候補を生成」と
 * 定義されているため、SP-03 T-03-06 では Marketer 入力契約 (MarketerThemeInput) と
 * 整合する `{ accountId, genre, keywordOrBrief, count, excludeTitlesRecent? }` を採用する。
 * (docs/05 §4.3.3 の `genres[]` は将来の複数ジャンル並列起動 UI 用に予約)
 */
export const GenerateThemesInputSchema = z.object({
  accountId: z.string().min(1).max(64),
  genre: z.enum(['practical', 'business', 'self_help']).nullable(),
  keywordOrBrief: z.string().min(1).max(500),
  count: z.number().int().min(1).max(30).default(10),
  /**
   * 直近採用済タイトル明示指定 (任意)。
   * 未指定時は worker タスク側で `theme_candidates` から直近 90 日を取得する。
   */
  excludeTitlesRecent: z.array(z.string()).max(500).optional(),
});

export type GenerateThemesInput = z.infer<typeof GenerateThemesInputSchema>;

/**
 * `bulkDecideThemes` の入力 schema (docs/05 §4.3.3).
 * S-006 BulkActionBar から呼ばれる。pending → accepted | rejected 一括遷移。
 */
export const BulkDecideThemesInputSchema = z.object({
  theme_ids: z.array(z.string().min(1)).min(1).max(100),
  decision: z.enum(['accept', 'reject']),
  reject_reason: z.string().max(500).optional(),
});

export type BulkDecideThemesInput = z.infer<typeof BulkDecideThemesInputSchema>;

/**
 * `acceptThemesAndStageBatch` の入力 schema (docs/05 §4.3.3).
 *
 * 採用ステータス遷移 + S-008 (`/batches/new`) へのハンドオフ先 URL を返す。
 * BatchPlan / BatchPlanItem 作成は S-008 側 (`createBatchPlan` SA, T-03-09)
 * で行うため、本 SA は accept 遷移 + redirect_to の組み立てのみに留める。
 */
export const AcceptThemesAndStageBatchInputSchema = z.object({
  theme_ids: z.array(z.string().min(1)).min(1).max(100),
});

export type AcceptThemesAndStageBatchInput = z.infer<
  typeof AcceptThemesAndStageBatchInputSchema
>;

// ---------------------------------------------------------------------------
// DI 境界
// ---------------------------------------------------------------------------

/** prisma.account の最小サブセット (FK 事前検証用)。 */
export interface AccountRepo {
  findUnique(args: {
    where: { id: string };
    select: { id: true; status: true };
  }): Promise<Pick<Account, 'id' | 'status'> | null>;
}

/** prisma.job の最小サブセット。 */
export interface JobRepo {
  create(args: {
    data: Prisma.JobUncheckedCreateInput;
  }): Promise<Pick<Job, 'id'>>;
}

/** prisma.auditLog.create の最小サブセット。 */
export interface AuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

/**
 * prisma.themeCandidate の最小サブセット。bulk SA で使用する。
 * `findMany`/`updateMany` を `status='pending'` 制約で扱うため、where 条件は
 * id IN リスト + status のみに限定して型を絞っている。
 */
export interface ThemeCandidateRepo {
  findMany(args: {
    where: {
      id: { in: string[] };
      status?: string | { in: string[] };
    };
    select?: Record<string, boolean>;
  }): Promise<
    Array<
      Pick<
        ThemeCandidate,
        'id' | 'account_id' | 'theme_session_id' | 'status' | 'title'
      >
    >
  >;
  updateMany(args: {
    where: { id: { in: string[] }; status?: string };
    data: { status: string; decided_at: Date; rejected_reason?: string | null };
  }): Promise<{ count: number }>;
}

/** graphile-worker enqueue 関数。本番では `enqueueJob` を注入。 */
export type EnqueueJobFn = (
  taskName: string,
  payload: unknown,
) => Promise<string>;

/**
 * bulk SA 用のトランザクション境界。SA ラッパは `prisma.$transaction` で tx
 * クライアントを生成して `themeCandidateRepo`/`auditLogRepo` を tx で差し替える。
 * 単体テストでは即時実行 (in-memory state) で十分。
 */
export type RunTransactionFn = <T>(
  fn: (txRepos: {
    themeCandidateRepo: ThemeCandidateRepo;
    auditLogRepo: AuditLogRepo;
  }) => Promise<T>,
) => Promise<T>;

export interface ThemesDeps {
  accountRepo: AccountRepo;
  jobRepo: JobRepo;
  auditLogRepo: AuditLogRepo;
  /** bulk SA でのみ参照。generateThemes だけを呼ぶ場合は省略可能。 */
  themeCandidateRepo?: ThemeCandidateRepo;
  /** bulk SA でのみ参照。generateThemes だけを呼ぶ場合は省略可能。 */
  runTransaction?: RunTransactionFn;
  session: AuthenticatedSession;
  enqueueJob: EnqueueJobFn;
  /** `theme_session_id` 生成器 (テストで決定論にするため DI 化)。 */
  genId?: () => string;
  now?: () => Date;
}

interface ResolvedDeps {
  accountRepo: AccountRepo;
  jobRepo: JobRepo;
  auditLogRepo: AuditLogRepo;
  themeCandidateRepo: ThemeCandidateRepo | null;
  runTransaction: RunTransactionFn | null;
  session: AuthenticatedSession;
  enqueueJob: EnqueueJobFn;
  genId: () => string;
  now: () => Date;
}

function resolveDeps(d: ThemesDeps): ResolvedDeps {
  return {
    accountRepo: d.accountRepo,
    jobRepo: d.jobRepo,
    auditLogRepo: d.auditLogRepo,
    themeCandidateRepo: d.themeCandidateRepo ?? null,
    runTransaction: d.runTransaction ?? null,
    session: d.session,
    enqueueJob: d.enqueueJob,
    genId: d.genId ?? (() => randomUUID()),
    now: d.now ?? (() => new Date()),
  };
}

function formatZodIssues(error: z.ZodError) {
  return error.issues.map((i) => ({
    path: i.path.join('.'),
    message: i.message,
  }));
}

// ---------------------------------------------------------------------------
// generateThemesCore
// ---------------------------------------------------------------------------

/** docs/05 §5.3 規約: `pipeline.theme.generate` (新規追加タスク)。 */
export const PIPELINE_THEME_GENERATE_TASK_NAME = 'pipeline.theme.generate';

export async function generateThemesCore(
  raw: unknown,
  rawDeps: ThemesDeps,
): Promise<ActionResult<{ session_id: string; job_id: string }>> {
  const deps = resolveDeps(rawDeps);
  const parsed = GenerateThemesInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.themes.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;

    // 1. Account 存在チェック (FK 違反前にきれいに弾く)
    const account = await deps.accountRepo.findUnique({
      where: { id: input.accountId },
      select: { id: true, status: true },
    });
    if (!account) {
      throw new NotFoundError('Account not found', {
        userMessage: messages.themes.errors.accountNotFound,
        details: { accountId: input.accountId },
      });
    }

    // 2. theme_session_id を生成 (Marketer/token_usage 集計キー、docs/05 §14 #6)
    const themeSessionId = deps.genId();

    // 3. 内部 Job 行を INSERT (book_id=null: 書籍未確定段階)
    //    payload_json に生成パラメタ一式を保存 → worker 側で再構築する
    const jobPayload = {
      theme_session_id: themeSessionId,
      account_id: input.accountId,
      genre: input.genre,
      keyword_or_brief: input.keywordOrBrief,
      count: input.count,
      ...(input.excludeTitlesRecent !== undefined
        ? { exclude_titles_recent: input.excludeTitlesRecent }
        : {}),
    };
    const job = await deps.jobRepo.create({
      data: {
        kind: PIPELINE_THEME_GENERATE_TASK_NAME,
        status: 'queued',
        payload_json: jobPayload as unknown as Prisma.InputJsonValue,
      },
    });

    // 4. graphile-worker enqueue
    //    payload は最小 — { theme_session_id, job_id } のみ。残りは Job.payload_json
    //    から worker が読み出す (再キュー時の payload 不変性を維持)。
    await deps.enqueueJob(PIPELINE_THEME_GENERATE_TASK_NAME, {
      theme_session_id: themeSessionId,
      job_id: job.id,
    });

    // 5. audit_log
    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'theme_session.generate',
        target_kind: 'theme_session',
        target_id: themeSessionId,
        before_json: Prisma.JsonNull,
        after_json: {
          theme_session_id: themeSessionId,
          job_id: job.id,
          account_id: input.accountId,
          genre: input.genre,
          count: input.count,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    return ok({ session_id: themeSessionId, job_id: job.id });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.themes.errors.enqueueFailed);
  }
}

// ---------------------------------------------------------------------------
// bulkDecideThemesCore (T-03-07, docs/05 §4.3.3, F-017)
// ---------------------------------------------------------------------------

/**
 * 選択された theme_ids のうち status='pending' の行のみを accept/reject に遷移する。
 *
 * - pending 以外 (accepted/rejected) は更新されない (冪等)
 * - updated=0 の場合は ValidationError (`no_pending`) を返す: UI は「pending の
 *   テーマのみ選択できる」ヒントを表示する
 * - audit_log は action='themes.bulk_decide' で 1 件記録
 *   (target_id は theme_session_id が複数になり得るので "bulk" 固定。詳細は
 *   after_json に theme_ids を載せる。)
 */
export async function bulkDecideThemesCore(
  raw: unknown,
  rawDeps: ThemesDeps,
): Promise<ActionResult<{ updated: number }>> {
  const deps = resolveDeps(rawDeps);
  if (!deps.themeCandidateRepo || !deps.runTransaction) {
    return fail('config', messages.themes.errors.bulkUnknown);
  }
  const parsed = BulkDecideThemesInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.themes.errors.bulkValidation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;
    const newStatus = input.decision === 'accept' ? 'accepted' : 'rejected';
    const rejectReason =
      input.decision === 'reject' && input.reject_reason ? input.reject_reason : null;

    const result = await deps.runTransaction(async (tx) => {
      // 1. 対象を fetch (pending のみ、audit / 結果集計用)
      const pendingRows = await tx.themeCandidateRepo.findMany({
        where: { id: { in: input.theme_ids }, status: 'pending' },
        select: {
          id: true,
          account_id: true,
          theme_session_id: true,
          status: true,
          title: true,
        },
      });

      if (pendingRows.length === 0) {
        throw new ValidationError('no pending themes selected', {
          userMessage: messages.themes.errors.noPending,
          details: { requested: input.theme_ids.length },
        });
      }

      const pendingIds = pendingRows.map((r) => r.id);
      const now = deps.now();

      // 2. status 遷移 (pending 制約付き — 競合書き込みに対する保険)
      const updated = await tx.themeCandidateRepo.updateMany({
        where: { id: { in: pendingIds }, status: 'pending' },
        data: {
          status: newStatus,
          decided_at: now,
          ...(rejectReason !== null ? { rejected_reason: rejectReason } : {}),
        },
      });

      // 3. audit_log (1 件、bulk)
      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'themes.bulk_decide',
          target_kind: 'theme_candidate',
          target_id: 'bulk',
          before_json: {
            theme_ids: pendingIds,
            previous_status: 'pending',
          } as unknown as Prisma.InputJsonValue,
          after_json: {
            theme_ids: pendingIds,
            decision: input.decision,
            new_status: newStatus,
            updated_count: updated.count,
            ...(rejectReason !== null ? { rejected_reason: rejectReason } : {}),
          } as unknown as Prisma.InputJsonValue,
        },
      });

      return updated.count;
    });

    return ok({ updated: result });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.themes.errors.bulkUnknown);
  }
}

// ---------------------------------------------------------------------------
// acceptThemesAndStageBatchCore (T-03-07, docs/05 §4.3.3)
// ---------------------------------------------------------------------------

/**
 * S-006「採用してバッチ計画へ」CTA。
 *
 * docs/05 §4.3.3 / docs/04 S-006 通り、本 SA は:
 *   1. 選択 theme のうち pending を accepted に遷移
 *   2. S-008 (`/batches/new`) への redirect URL を返す (theme_ids を query 引数で渡す)
 *
 * BatchPlan / BatchPlanItem 作成は S-008 側 `createBatchPlan` SA (T-03-09) で
 * 並列度・予測コスト・開始時刻の入力を経て確定する設計のため、ここでは作らない。
 *
 * - accepted/rejected 済みでも redirect_to には含める (UI 側で既採用テーマも
 *   バッチに混ぜたい想定。docs/04 §S-008 「追加/削除可」)
 * - 1 件以上 pending → accepted 遷移するか、もしくは選択行が既に全て accepted なら
 *   ok を返す (= 採用済みテーマの再ハンドオフ)
 * - rejected が 1 件でも混在していれば ValidationError
 */
export async function acceptThemesAndStageBatchCore(
  raw: unknown,
  rawDeps: ThemesDeps,
): Promise<ActionResult<{ staged_count: number; redirect_to: string }>> {
  const deps = resolveDeps(rawDeps);
  if (!deps.themeCandidateRepo || !deps.runTransaction) {
    return fail('config', messages.themes.errors.bulkUnknown);
  }
  const parsed = AcceptThemesAndStageBatchInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.themes.errors.bulkValidation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;

    const result = await deps.runTransaction(async (tx) => {
      // 1. 対象全件取得 (pending + accepted + rejected を含めて判定)
      const rows = await tx.themeCandidateRepo.findMany({
        where: { id: { in: input.theme_ids } },
        select: {
          id: true,
          account_id: true,
          theme_session_id: true,
          status: true,
          title: true,
        },
      });

      if (rows.length === 0) {
        throw new NotFoundError('themes not found', {
          userMessage: messages.themes.errors.bulkValidation,
          details: { theme_ids: input.theme_ids },
        });
      }

      // 2. rejected が混在していたら ValidationError
      const rejected = rows.filter((r) => r.status === 'rejected');
      if (rejected.length > 0) {
        throw new ValidationError('rejected themes cannot be staged', {
          userMessage: messages.themes.errors.bulkValidation,
          details: { rejected_ids: rejected.map((r) => r.id) },
        });
      }

      const pendingIds = rows.filter((r) => r.status === 'pending').map((r) => r.id);
      const now = deps.now();
      let updatedCount = 0;

      // 3. pending を accepted に遷移 (該当があれば)
      if (pendingIds.length > 0) {
        const updated = await tx.themeCandidateRepo.updateMany({
          where: { id: { in: pendingIds }, status: 'pending' },
          data: { status: 'accepted', decided_at: now },
        });
        updatedCount = updated.count;
      }

      // 4. audit_log (stage_batch)
      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'themes.stage_batch',
          target_kind: 'theme_candidate',
          target_id: 'bulk',
          before_json: {
            theme_ids: rows.map((r) => r.id),
            pending_ids: pendingIds,
          } as unknown as Prisma.InputJsonValue,
          after_json: {
            theme_ids: rows.map((r) => r.id),
            accepted_count: updatedCount,
            total_staged: rows.length,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      return { stagedCount: rows.length, allIds: rows.map((r) => r.id) };
    });

    const qs = new URLSearchParams();
    qs.set('theme_ids', result.allIds.join(','));
    return ok({
      staged_count: result.stagedCount,
      redirect_to: `/batches/new?${qs.toString()}`,
    });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.themes.errors.bulkUnknown);
  }
}
