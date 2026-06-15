/**
 * Batches Server Action のコアロジック (T-03-09, F-010 / F-021).
 *
 * `app/actions/batches.ts` (SA ラッパ) から呼ばれる業務ロジック。
 * 依存 (prisma / enqueueJob / session / now / genId) は全て DI で受け取り、
 * Vitest で純粋にユニットテスト可能にする (themes-core / model-assignments-core
 * と同パターン)。
 *
 * 仕様根拠:
 *  - docs/05 §4.3.4 `createBatchPlan` / `kickBatchNow` SA
 *  - docs/05 §5.3.1 `pipeline.book.kickoff` payload
 *  - docs/02 F-010 / F-021 受入基準
 *  - docs/04 §4 S-008
 *
 * フロー (createBatchPlan):
 *  1. 入力 zod 検証
 *  2. ThemeCandidate を `id IN themeIds, status='accepted'` で fetch
 *  3. 全件 accepted でなければ ValidationError
 *  4. transaction で:
 *     a. BatchPlan INSERT (planned_at / concurrency / status='scheduled'
 *        / predicted_cost_jpy)
 *     b. 各 theme について BatchPlanItem INSERT (theme_id / status='pending')
 *     c. audit_log 1 件 (action='batch_plan.create')
 *
 * フロー (kickBatchNow):
 *  1. 入力 zod 検証
 *  2. BatchPlan fetch (status='scheduled' のみ)
 *  3. transaction で各 BatchPlanItem について:
 *     a. 内部 Job INSERT (`kind='pipeline.book.kickoff'`, status='queued',
 *        payload に theme_id / account_id / batch_plan_item_id / job_id)
 *     b. graphile-worker へ enqueueJob('pipeline.book.kickoff', payload)
 *     c. BatchPlanItem.status='kicked'
 *  4. BatchPlan.status='running', kicked_at=now()
 *  5. audit_log 1 件 (action='batch_plan.kick')
 *
 * NOTE: docs/05 §4.3.4 の SA 戻り型では `predicted_cost_jpy` /
 * `would_exceed_monthly` を含む。月次超過判定は SP-04 で sales/cost 統合される
 * ため、T-03-09 では `would_exceed_monthly: false` 固定とする (TODO marker)。
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  ConflictError,
  NotFoundError,
  ValidationError,
  isA2PError,
  fail,
  ok,
  type ActionResult,
} from '@a2p/contracts';
import {
  Prisma,
  type BatchPlan,
  type BatchPlanItem,
  type Job,
  type ModelAssignment,
  type ModelCatalog,
  type ThemeCandidate,
} from '@a2p/db';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// zod schemas — docs/05 §4.3.4
// ---------------------------------------------------------------------------

export const SNAPSHOT_ROLES = [
  'marketer',
  'writer',
  'editor',
  'judge',
  'thumbnail_text',
  'thumbnail_image',
  'optimizer',
] as const;

export type SnapshotRole = (typeof SNAPSHOT_ROLES)[number];

/**
 * createBatchPlan の入力 schema。
 *
 * docs/05 §4.3.4 では `planned_at: z.string().datetime()` (必須)。SP-03 では
 * UI が「即時キック」 (planned_at 省略 → now+1 日の 23:00 を既定) と
 * 「スケジュール登録」を切り替えるため、本 schema では `plannedAt` を optional
 * とし core 側で既定値を構成する。
 */
export const CreateBatchPlanInputSchema = z.object({
  themeIds: z.array(z.string().min(1)).min(1).max(100),
  plannedAt: z.string().datetime().optional(),
  concurrency: z.number().int().min(1).max(10).default(5),
  deadline: z.string().datetime().optional(),
  overrideModelAssignments: z
    .record(
      z.enum(SNAPSHOT_ROLES),
      z.object({ provider: z.string().min(1), model: z.string().min(1) }),
    )
    .optional(),
});

export type CreateBatchPlanInput = z.infer<typeof CreateBatchPlanInputSchema>;

export const KickBatchNowInputSchema = z.object({
  batchPlanId: z.string().min(1),
  /** 月次予算超過時でも強制続行する (F-036 §T-07-10)。 */
  force: z.boolean().optional(),
});

export type KickBatchNowInput = z.infer<typeof KickBatchNowInputSchema>;

// ---------------------------------------------------------------------------
// 予測コスト計算 — docs/04 S-008 §5
// ---------------------------------------------------------------------------

/**
 * 1 冊あたりの役割別 token 数推定 (SP-03 暫定固定値)。
 * SP-04 以降で過去実績の移動平均に置換する。
 */
export const PER_BOOK_TOKEN_ESTIMATE: Record<
  SnapshotRole,
  { input: number; output: number; imageCount: number }
> = {
  marketer: { input: 8_000, output: 2_000, imageCount: 0 },
  writer: { input: 50_000, output: 60_000, imageCount: 0 },
  editor: { input: 30_000, output: 30_000, imageCount: 0 },
  judge: { input: 20_000, output: 4_000, imageCount: 0 },
  thumbnail_text: { input: 4_000, output: 1_500, imageCount: 0 },
  // gpt-image-1 は画像 1 枚あたりの cost。token は無視。
  thumbnail_image: { input: 0, output: 0, imageCount: 3 },
  optimizer: { input: 0, output: 0, imageCount: 0 },
};

export interface ForecastModelAssignmentInput {
  role: string;
  provider: string;
  model: string;
}

export interface ForecastCatalogRow {
  provider: string;
  model: string;
  /** USD / 1M tokens (Decimal は string 化済前提)。 */
  inputPricePerMtokUsd: number;
  outputPricePerMtokUsd: number;
  /** USD / image。null は未対応モデル。 */
  imagePricePerImageUsd: number | null;
  /** USD/JPY 為替レート。 */
  fxRateUsdJpy: number;
}

export interface ForecastResult {
  /** 1 冊あたり予測コスト (JPY、四捨五入)。 */
  perBookJpy: number;
  /** themeCount × perBookJpy。 */
  totalJpy: number;
  themeCount: number;
  /** カタログ未取得 / 未割当の役割。UI で警告表示する。 */
  missingRoles: SnapshotRole[];
}

/**
 * 予測コスト計算 — 役割ごとに `(input_tok × input_price + output_tok × output_price)`
 * を USD で算出し、為替を掛けて JPY 化。画像生成は `image_count × image_price` を加算。
 *
 * - assignments / catalog が引けない役割は 0 コスト + missingRoles に記録
 * - 1 冊あたりは四捨五入、合計は per-book × themeCount で再計算
 */
export function forecastBookCostJpy(args: {
  themeCount: number;
  assignments: ForecastModelAssignmentInput[];
  catalog: ForecastCatalogRow[];
  overrides?: Partial<Record<SnapshotRole, { provider: string; model: string }>>;
}): ForecastResult {
  const assignmentByRole = new Map<string, ForecastModelAssignmentInput>();
  for (const a of args.assignments) {
    // role × genre は SP-04 で扱う。SP-03 では「同 role の active」を 1 件にする。
    if (!assignmentByRole.has(a.role)) assignmentByRole.set(a.role, a);
  }

  const catalogByPair = new Map<string, ForecastCatalogRow>();
  for (const c of args.catalog) {
    catalogByPair.set(`${c.provider}/${c.model}`, c);
  }

  const missingRoles: SnapshotRole[] = [];
  let perBookUsd = 0;
  let perBookImageJpy = 0;

  for (const role of SNAPSHOT_ROLES) {
    const est = PER_BOOK_TOKEN_ESTIMATE[role];
    const override = args.overrides?.[role];
    const assignment = override
      ? { role, provider: override.provider, model: override.model }
      : assignmentByRole.get(role);
    if (!assignment) {
      missingRoles.push(role);
      continue;
    }
    const cat = catalogByPair.get(`${assignment.provider}/${assignment.model}`);
    if (!cat) {
      missingRoles.push(role);
      continue;
    }
    // 1M token あたり単価 × 実 token 数 / 1_000_000
    const tokenUsd =
      (est.input * cat.inputPricePerMtokUsd) / 1_000_000 +
      (est.output * cat.outputPricePerMtokUsd) / 1_000_000;
    perBookUsd += tokenUsd;
    if (est.imageCount > 0 && cat.imagePricePerImageUsd !== null) {
      // 画像コストは JPY 直接加算 (USD→JPY 為替を per-row で持つため早めに変換)
      perBookImageJpy += est.imageCount * cat.imagePricePerImageUsd * cat.fxRateUsdJpy;
    }
  }

  // USD→JPY 変換は marketer の fx_rate を代表値として使う (SP-04 で最新値に統一)
  const fxFallback = args.catalog[0]?.fxRateUsdJpy ?? 150;
  const perBookJpyRaw = perBookUsd * fxFallback + perBookImageJpy;
  const perBookJpy = Math.round(perBookJpyRaw);
  const totalJpy = perBookJpy * args.themeCount;

  return {
    perBookJpy,
    totalJpy,
    themeCount: args.themeCount,
    missingRoles,
  };
}

// ---------------------------------------------------------------------------
// 月次予算超過予測 — F-036 / T-07-10
// ---------------------------------------------------------------------------

/** UTC 月の日数。 */
function daysInMonthUtc(year: number, month: number): number {
  // month は 1-based。次月 0 日 = 当月末日。
  return new Date(Date.UTC(year, month, 0)).getDate();
}

/**
 * 月初から `now` までの実績コスト + バッチ推定コストを月末まで線形外挿し、
 * `redThresholdJpy` を超えるかを判定する。
 *
 * alert-cost-check.ts monthly scope と同じ外挿式を使う。
 */
export function projectExceedsRedThreshold(args: {
  actualCostJpy: number;
  batchCostJpy: number;
  elapsedDays: number;
  totalDays: number;
  redThresholdJpy: number;
}): boolean {
  const { actualCostJpy, batchCostJpy, elapsedDays, totalDays, redThresholdJpy } = args;
  if (elapsedDays <= 0) return false;
  const projected = (actualCostJpy / elapsedDays) * totalDays + batchCostJpy;
  return projected >= redThresholdJpy;
}

// ---------------------------------------------------------------------------
// DI 境界
// ---------------------------------------------------------------------------

/** prisma.themeCandidate の最小サブセット (createBatchPlan の事前検証)。 */
export interface ThemeCandidateRepo {
  findMany(args: {
    where: { id: { in: string[] } };
    select: {
      id: true;
      account_id: true;
      status: true;
      title: true;
      genre: true;
    };
  }): Promise<
    Array<
      Pick<ThemeCandidate, 'id' | 'account_id' | 'status' | 'title' | 'genre'>
    >
  >;
}

/** prisma.batchPlan の最小サブセット。 */
export interface BatchPlanRepo {
  create(args: {
    data: Prisma.BatchPlanUncheckedCreateInput;
  }): Promise<Pick<BatchPlan, 'id' | 'planned_at'>>;
  findUnique(args: {
    where: { id: string };
    include?: { items?: boolean };
  }): Promise<
    | (BatchPlan & {
        items?: BatchPlanItem[];
      })
    | null
  >;
  update(args: {
    where: { id: string };
    data: Prisma.BatchPlanUncheckedUpdateInput;
  }): Promise<unknown>;
}

/** prisma.batchPlanItem の最小サブセット。 */
export interface BatchPlanItemRepo {
  create(args: {
    data: Prisma.BatchPlanItemUncheckedCreateInput;
  }): Promise<Pick<BatchPlanItem, 'id' | 'theme_id'>>;
  update(args: {
    where: { id: string };
    data: Prisma.BatchPlanItemUncheckedUpdateInput;
  }): Promise<unknown>;
}

/** prisma.job の最小サブセット。 */
export interface JobRepo {
  create(args: {
    data: Prisma.JobUncheckedCreateInput;
  }): Promise<Pick<Job, 'id'>>;
}

/** prisma.modelAssignment / modelCatalog の最小サブセット (predicted_cost 計算用)。 */
export interface ModelAssignmentReadRepo {
  findMany(args: {
    where: { status: string };
  }): Promise<
    Array<Pick<ModelAssignment, 'role' | 'genre' | 'provider' | 'model'>>
  >;
}

export interface ModelCatalogReadRepo {
  findMany(args: { where: { is_current: boolean } }): Promise<ModelCatalog[]>;
}

/** prisma.auditLog.create の最小サブセット。 */
export interface AuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

/** AppSettings の月次予算判定に必要なフィールド最小サブセット。 */
export interface AppSettingsMonthlyRepo {
  findUnique(args: {
    where: { id: string };
    select: {
      monthly_cost_red_jpy: true;
      force_continue: true;
    };
  }): Promise<{
    monthly_cost_red_jpy: number;
    force_continue: boolean;
  } | null>;
}

/** packages/db/src/cost-aggregation の getMonthlyTotalCost 関数型。 */
export type GetMonthlyTotalCostFn = (
  prisma: unknown,
  year: number,
  month: number,
) => Promise<{ year: number; month: number; total_cost_jpy: number }>;

/** graphile-worker enqueue 関数。本番では `enqueueJob` を注入。 */
export type EnqueueJobFn = (
  taskName: string,
  payload: unknown,
) => Promise<string>;

/**
 * createBatchPlan 用のトランザクション境界。
 * SA ラッパは `prisma.$transaction(async (tx) => fn({ batchPlanRepo: tx.batchPlan, ... }))`
 * で tx クライアントを注入する。
 */
export type CreateBatchPlanTxFn = <T>(
  fn: (txRepos: {
    batchPlanRepo: BatchPlanRepo;
    batchPlanItemRepo: BatchPlanItemRepo;
    auditLogRepo: AuditLogRepo;
  }) => Promise<T>,
) => Promise<T>;

/**
 * kickBatchNow 用のトランザクション境界。Job/BatchPlan/BatchPlanItem を tx に揃える。
 * graphile-worker enqueue 自体は tx 外で実行する (PG にコミットされる前の enqueue を
 * 避ける) ため、本 fn は「DB 更新」だけを束ねる。enqueue は別途呼び出す。
 *
 * SP-03 では並列度の都合上、シンプルに「INSERT Job → enqueue → BatchPlanItem 更新」
 * の順で 1 件ずつ処理する設計を採用。tx は per-batch-item で短く保つ。
 */
export type KickBatchNowTxFn = <T>(
  fn: (txRepos: {
    batchPlanRepo: BatchPlanRepo;
    batchPlanItemRepo: BatchPlanItemRepo;
    jobRepo: JobRepo;
    auditLogRepo: AuditLogRepo;
  }) => Promise<T>,
) => Promise<T>;

export interface BatchesDeps {
  themeCandidateRepo: ThemeCandidateRepo;
  batchPlanRepo: BatchPlanRepo;
  batchPlanItemRepo: BatchPlanItemRepo;
  jobRepo: JobRepo;
  modelAssignmentRepo: ModelAssignmentReadRepo;
  modelCatalogRepo: ModelCatalogReadRepo;
  auditLogRepo: AuditLogRepo;
  /** AppSettings から月次予算閾値を読む (T-07-10)。省略時はスキップ (テスト用)。 */
  appSettingsRepo?: AppSettingsMonthlyRepo;
  /** getMonthlyTotalCost の注入点 (T-07-10 テスト決定論用)。 */
  getMonthlyTotalCostFn?: GetMonthlyTotalCostFn;
  session: AuthenticatedSession;
  runCreateTransaction: CreateBatchPlanTxFn;
  runKickTransaction: KickBatchNowTxFn;
  enqueueJob: EnqueueJobFn;
  /** Job.id 生成器 (テスト決定論用)。Prisma 既定 cuid に任せるなら省略。 */
  genId?: () => string;
  now?: () => Date;
}

interface ResolvedDeps {
  themeCandidateRepo: ThemeCandidateRepo;
  batchPlanRepo: BatchPlanRepo;
  batchPlanItemRepo: BatchPlanItemRepo;
  jobRepo: JobRepo;
  modelAssignmentRepo: ModelAssignmentReadRepo;
  modelCatalogRepo: ModelCatalogReadRepo;
  auditLogRepo: AuditLogRepo;
  appSettingsRepo: AppSettingsMonthlyRepo | undefined;
  getMonthlyTotalCostFn: GetMonthlyTotalCostFn | undefined;
  session: AuthenticatedSession;
  runCreateTransaction: CreateBatchPlanTxFn;
  runKickTransaction: KickBatchNowTxFn;
  enqueueJob: EnqueueJobFn;
  genId: () => string;
  now: () => Date;
}

function resolveDeps(d: BatchesDeps): ResolvedDeps {
  return {
    themeCandidateRepo: d.themeCandidateRepo,
    batchPlanRepo: d.batchPlanRepo,
    batchPlanItemRepo: d.batchPlanItemRepo,
    jobRepo: d.jobRepo,
    modelAssignmentRepo: d.modelAssignmentRepo,
    modelCatalogRepo: d.modelCatalogRepo,
    auditLogRepo: d.auditLogRepo,
    appSettingsRepo: d.appSettingsRepo,
    getMonthlyTotalCostFn: d.getMonthlyTotalCostFn,
    session: d.session,
    runCreateTransaction: d.runCreateTransaction,
    runKickTransaction: d.runKickTransaction,
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

/** 既定 planned_at: 今日の 23:00 JST (= UTC 14:00)。 */
function defaultPlannedAt(now: Date): Date {
  // JST = UTC+9。23:00 JST = 14:00 UTC。
  const utcMs = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    14,
    0,
    0,
    0,
  );
  // 既に 14:00 UTC を過ぎていれば翌日に倒す。
  const candidate = new Date(utcMs);
  if (candidate.getTime() <= now.getTime()) {
    return new Date(utcMs + 24 * 60 * 60 * 1000);
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// createBatchPlanCore (T-03-09, docs/05 §4.3.4)
// ---------------------------------------------------------------------------

export const PIPELINE_BOOK_KICKOFF_TASK_NAME = 'pipeline.book.kickoff';

export interface CreateBatchPlanResult {
  batch_id: string;
  predicted_cost_jpy: number;
  would_exceed_monthly: boolean;
  item_count: number;
  scheduled_at: string;
}

export async function createBatchPlanCore(
  raw: unknown,
  rawDeps: BatchesDeps,
): Promise<ActionResult<CreateBatchPlanResult>> {
  const deps = resolveDeps(rawDeps);
  const parsed = CreateBatchPlanInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.batches.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;
    const themeIds = Array.from(new Set(input.themeIds));

    // 1. ThemeCandidate fetch (status='accepted' 制約)
    const themes = await deps.themeCandidateRepo.findMany({
      where: { id: { in: themeIds } },
      select: {
        id: true,
        account_id: true,
        status: true,
        title: true,
        genre: true,
      },
    });
    const foundIds = new Set(themes.map((t) => t.id));
    const missing = themeIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new NotFoundError('one or more themes not found', {
        userMessage: messages.batches.errors.themesNotFound,
        details: { missing },
      });
    }
    const nonAccepted = themes.filter((t) => t.status !== 'accepted');
    if (nonAccepted.length > 0) {
      throw new ValidationError('non-accepted themes cannot be staged', {
        userMessage: messages.batches.errors.themesNotAccepted,
        details: { non_accepted_ids: nonAccepted.map((t) => t.id) },
      });
    }

    // 2. 予測コスト (assignments / catalog を即時 fetch して算出)
    const [assignments, catalogRows] = await Promise.all([
      deps.modelAssignmentRepo.findMany({ where: { status: 'active' } }),
      deps.modelCatalogRepo.findMany({ where: { is_current: true } }),
    ]);
    const forecast = forecastBookCostJpy({
      themeCount: themes.length,
      assignments: assignments.map((a) => ({
        role: a.role,
        provider: a.provider,
        model: a.model,
      })),
      catalog: catalogRows.map((c) => ({
        provider: c.provider,
        model: c.model,
        inputPricePerMtokUsd: Number(c.input_price_per_mtok_usd),
        outputPricePerMtokUsd: Number(c.output_price_per_mtok_usd),
        imagePricePerImageUsd:
          c.image_price_per_image_usd === null
            ? null
            : Number(c.image_price_per_image_usd),
        fxRateUsdJpy: Number(c.fx_rate_usd_jpy),
      })),
      overrides: input.overrideModelAssignments,
    });

    // 3. plannedAt の確定 (省略時は今日の 23:00 JST)
    const plannedAt = input.plannedAt
      ? new Date(input.plannedAt)
      : defaultPlannedAt(deps.now());

    // 4. transaction で BatchPlan + BatchPlanItem * N + audit_log
    const result = await deps.runCreateTransaction(async (tx) => {
      const plan = await tx.batchPlanRepo.create({
        data: {
          planned_at: plannedAt,
          concurrency: input.concurrency,
          deadline: input.deadline ? new Date(input.deadline) : null,
          predicted_cost_jpy: forecast.totalJpy,
          status: 'scheduled',
        },
      });

      const items: Array<Pick<BatchPlanItem, 'id' | 'theme_id'>> = [];
      for (const theme of themes) {
        const item = await tx.batchPlanItemRepo.create({
          data: {
            batch_id: plan.id,
            theme_id: theme.id,
            status: 'pending',
            override_model_assignments_json: input.overrideModelAssignments
              ? (input.overrideModelAssignments as unknown as Prisma.InputJsonValue)
              : Prisma.JsonNull,
          },
        });
        items.push(item);
      }

      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'batch_plan.create',
          target_kind: 'batch_plan',
          target_id: plan.id,
          before_json: Prisma.JsonNull,
          after_json: {
            batch_id: plan.id,
            planned_at: plannedAt.toISOString(),
            concurrency: input.concurrency,
            theme_ids: themes.map((t) => t.id),
            predicted_cost_jpy: forecast.totalJpy,
          } as unknown as Prisma.InputJsonValue,
        },
      });

      return { plan, items };
    });

    // 5. 月次予算超過予測 (T-07-10)
    let wouldExceedMonthly = false;
    if (deps.appSettingsRepo && deps.getMonthlyTotalCostFn) {
      const now = deps.now();
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;
      const [settings, monthlyResult] = await Promise.all([
        deps.appSettingsRepo.findUnique({
          where: { id: 'singleton' },
          select: { monthly_cost_red_jpy: true, force_continue: true },
        }),
        deps.getMonthlyTotalCostFn(null, year, month),
      ]);
      if (settings) {
        wouldExceedMonthly = projectExceedsRedThreshold({
          actualCostJpy: monthlyResult.total_cost_jpy,
          batchCostJpy: forecast.totalJpy,
          elapsedDays: now.getUTCDate(),
          totalDays: daysInMonthUtc(year, month),
          redThresholdJpy: settings.monthly_cost_red_jpy,
        });
      }
    }

    return ok({
      batch_id: result.plan.id,
      predicted_cost_jpy: forecast.totalJpy,
      would_exceed_monthly: wouldExceedMonthly,
      item_count: result.items.length,
      scheduled_at: plannedAt.toISOString(),
    });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.batches.errors.unknown);
  }
}

// ---------------------------------------------------------------------------
// kickBatchNowCore (T-03-09, docs/05 §4.3.4)
// ---------------------------------------------------------------------------

export interface KickBatchNowResult {
  batch_id: string;
  jobs: Array<{ job_id: string; theme_id: string; graphile_job_id: string }>;
  kicked_count: number;
}

export async function kickBatchNowCore(
  raw: unknown,
  rawDeps: BatchesDeps,
): Promise<ActionResult<KickBatchNowResult>> {
  const deps = resolveDeps(rawDeps);
  const parsed = KickBatchNowInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.batches.errors.validation, {
      issues: formatZodIssues(parsed.error),
    });
  }

  try {
    const input = parsed.data;

    // 1. BatchPlan fetch (status='scheduled' 必須)
    const plan = await deps.batchPlanRepo.findUnique({
      where: { id: input.batchPlanId },
      include: { items: true },
    });
    if (!plan) {
      throw new NotFoundError('batch plan not found', {
        userMessage: messages.batches.errors.notFound,
        details: { batchPlanId: input.batchPlanId },
      });
    }
    if (plan.status !== 'scheduled') {
      throw new ValidationError('batch plan is not in scheduled state', {
        userMessage: messages.batches.errors.statusNotScheduled,
        details: { batchPlanId: input.batchPlanId, status: plan.status },
      });
    }
    const items = plan.items ?? [];

    // 月次予算超過チェック (T-07-10): force=true または force_continue=true の場合はスキップ
    if (!input.force && deps.appSettingsRepo && deps.getMonthlyTotalCostFn) {
      const now = deps.now();
      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;
      const [settings, monthlyResult] = await Promise.all([
        deps.appSettingsRepo.findUnique({
          where: { id: 'singleton' },
          select: { monthly_cost_red_jpy: true, force_continue: true },
        }),
        deps.getMonthlyTotalCostFn(null, year, month),
      ]);
      if (settings && !settings.force_continue) {
        const batchCost = Number(plan.predicted_cost_jpy ?? 0);
        const exceeds = projectExceedsRedThreshold({
          actualCostJpy: monthlyResult.total_cost_jpy,
          batchCostJpy: batchCost,
          elapsedDays: now.getUTCDate(),
          totalDays: daysInMonthUtc(year, month),
          redThresholdJpy: settings.monthly_cost_red_jpy,
        });
        if (exceeds) {
          throw new ConflictError('monthly budget red threshold would be exceeded', {
            userMessage: messages.batches.errors.monthlyBudgetExceeded,
            details: {
              batchPlanId: input.batchPlanId,
              monthly_cost_red_jpy: settings.monthly_cost_red_jpy,
              actual_cost_jpy: monthlyResult.total_cost_jpy,
              batch_cost_jpy: batchCost,
            },
          });
        }
      }
    }

    // 各 item に紐づく theme の account_id が必要なので一括 fetch
    const themeIds = items
      .map((i) => i.theme_id)
      .filter((id): id is string => id !== null);
    const themes = await deps.themeCandidateRepo.findMany({
      where: { id: { in: themeIds } },
      select: {
        id: true,
        account_id: true,
        status: true,
        title: true,
        genre: true,
      },
    });
    const themeById = new Map(themes.map((t) => [t.id, t]));

    const jobsCreated: KickBatchNowResult['jobs'] = [];
    const kickedAt = deps.now();

    // 2. per-item: 内部 Job 行 INSERT (tx) → enqueueJob (tx 外) → BatchPlanItem.status=kicked (tx)
    //    トランザクションを per-item で短く保つことで、enqueueJob 失敗時にも
    //    成功済み item は kicked のまま残し、失敗 item だけ再試行できる構造にする。
    for (const item of items) {
      if (!item.theme_id) continue; // BatchPlanItem.theme_id NULL は無効、スキップ
      const theme = themeById.get(item.theme_id);
      if (!theme) {
        throw new NotFoundError('theme referenced by BatchPlanItem not found', {
          userMessage: messages.batches.errors.themesNotFound,
          details: { batch_plan_item_id: item.id, theme_id: item.theme_id },
        });
      }

      const override =
        (item.override_model_assignments_json as Prisma.InputJsonValue | null) ??
        null;

      // 2-a. Job INSERT
      const createdJob = await deps.runKickTransaction(async (tx) => {
        const job = await tx.jobRepo.create({
          data: {
            kind: PIPELINE_BOOK_KICKOFF_TASK_NAME,
            status: 'queued',
            payload_json: {
              theme_id: theme.id,
              account_id: theme.account_id,
              batch_plan_item_id: item.id,
              ...(override !== null && override !== undefined
                ? { model_assignment_overrides: override }
                : {}),
            } as unknown as Prisma.InputJsonValue,
          },
        });
        return job;
      });

      // 2-b. enqueueJob — payload に job_id を入れる (pipeline.book.kickoff の payload 必須項目)
      const enqPayload = {
        theme_id: theme.id,
        account_id: theme.account_id,
        batch_plan_item_id: item.id,
        job_id: createdJob.id,
        ...(override !== null && override !== undefined
          ? { model_assignment_overrides: override }
          : {}),
      };
      let graphileJobId: string;
      try {
        graphileJobId = await deps.enqueueJob(
          PIPELINE_BOOK_KICKOFF_TASK_NAME,
          enqPayload,
        );
      } catch (enqErr) {
        // enqueue 失敗時は Job 行は queued のまま残す (運用で再キューする想定)。
        // ここでは即 throw → 上位 catch で fail に。
        throw new ValidationError('failed to enqueue kickoff job', {
          userMessage: messages.batches.errors.enqueueFailed,
          details: {
            batch_plan_item_id: item.id,
            cause: (enqErr as Error).message,
          },
        });
      }

      // 2-c. BatchPlanItem.status='kicked'
      await deps.runKickTransaction(async (tx) => {
        await tx.batchPlanItemRepo.update({
          where: { id: item.id },
          data: { status: 'kicked' },
        });
      });

      jobsCreated.push({
        job_id: createdJob.id,
        theme_id: theme.id,
        graphile_job_id: graphileJobId,
      });
    }

    // 3. BatchPlan.status='running' + kicked_at + audit_log
    await deps.runKickTransaction(async (tx) => {
      await tx.batchPlanRepo.update({
        where: { id: plan.id },
        data: { status: 'running', kicked_at: kickedAt },
      });
      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'batch_plan.kick',
          target_kind: 'batch_plan',
          target_id: plan.id,
          before_json: {
            batch_id: plan.id,
            status: 'scheduled',
          } as unknown as Prisma.InputJsonValue,
          after_json: {
            batch_id: plan.id,
            status: 'running',
            kicked_at: kickedAt.toISOString(),
            kicked_count: jobsCreated.length,
            job_ids: jobsCreated.map((j) => j.job_id),
          } as unknown as Prisma.InputJsonValue,
        },
      });
    });

    return ok({
      batch_id: plan.id,
      jobs: jobsCreated,
      kicked_count: jobsCreated.length,
    });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.batches.errors.unknown);
  }
}
