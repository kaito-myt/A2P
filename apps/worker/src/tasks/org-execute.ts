import { randomUUID } from 'node:crypto';

import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  analyzeSales as defaultAnalyzeSales,
  researchMarket as defaultResearchMarket,
  draftMetadata as defaultDraftMetadata,
  analyzePromotion as defaultAnalyzePromotion,
  reviewCosts as defaultReviewCosts,
  planAccountStrategy as defaultPlanAccountStrategy,
  type SalesAnalystInput,
  type SalesAnalystDeps,
  type MarketAnalystInput,
  type MarketAnalystDeps,
  type MetadataWorkerInput,
  type MetadataWorkerDeps,
  type PromoAnalystInput,
  type PromoAnalystDeps,
  type CostAccountantInput,
  type CostAccountantDeps,
  type AccountStrategistInput,
  type AccountStrategistDeps,
} from '@a2p/agents';
import {
  DISPATCHABLE_KINDS,
  DIVISION_KINDS,
  DIVISION_DEFAULT_KIND,
  DIVISION_DEFAULT_ASSIGNEE,
  depsSatisfied,
  priorityRank,
  type AnalysisSuggestion,
  type Division,
  type MetadataDraftOutput,
  type SalesAnalysisOutput,
  type MarketResearchOutput,
  type PromoAnalysisOutput,
  type CostReportOutput,
  type AccountStrategyOutput,
} from '@a2p/contracts/org';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import { PIPELINE_THEME_GENERATE_TASK_NAME } from './pipeline-theme-generate.js';
import { PIPELINE_BOOK_KICKOFF_TASK_NAME } from './pipeline-book-kickoff.js';
import { PIPELINE_BOOK_PROMOTION_GENERATE_TASK_NAME } from './pipeline-book-promotion-generate.js';
import { PROMOTION_DISPATCH_TASK_NAME } from './promotion-dispatch.js';
import { computeCostAggregate, aggregateToSnapshot, type FinancePrisma } from './org-finance-lib.js';

/** 制作パイプラインのステップ進行順（recover_job で最進捗の失敗ステップを選ぶ）。 */
const PIPELINE_STEP_ORDER: readonly string[] = [
  'pipeline.book.kickoff',
  'pipeline.book.marketer',
  'pipeline.book.writer.outline',
  'pipeline.book.writer.chapters.dispatch',
  'pipeline.book.writer.chapter',
  'pipeline.book.editor',
  'pipeline.book.thumbnail.text',
  'pipeline.book.thumbnail.image',
  'pipeline.book.judge',
  'pipeline.book.export',
];

/** `helpers.addJob` の最小 I/F（テスト時は mock を差し込む）。 */
export type EnqueueJobLike = (taskName: string, payload: unknown) => Promise<unknown>;

/**
 * `org.execute.dispatch` タスク (docs/06 §8-2) — 担当者による実行ディスパッチ。
 *
 * `approved` かつ依存充足かつ期限到来の org_tasks を、担当ロール別に実行する:
 *  - analytics: analyze_sales / research_market / report → 新規LLM担当が示唆を result_json に格納し
 *    本部横断の改善ToDo(proposed)を連鎖起票
 *  - publishing: prepare_metadata / set_price → metadata_worker が KDP メタデータ草案を result_json に
 *  - production: plan_book → テーマ生成(pipeline.theme.generate)を enqueue / write → 制作起動
 *    (pipeline.book.kickoff)を enqueue（テーマ承認済み前提）
 *
 * 各実行の LLM コストは token_usage.org_task_id 経由で集計し org_tasks.cost_jpy に確定する。
 * 暴走防止のため 1 回の dispatch で処理するタスク数に上限を設ける。
 */

export const ORG_EXECUTE_DISPATCH_TASK_NAME = 'org.execute.dispatch';

/** 1 回の dispatch で着手する最大タスク数（暴走防止）。 */
const MAX_DISPATCH_PER_RUN = 8;
/** 1 分析あたり連鎖起票する改善ToDoの上限。 */
const MAX_FOLLOWUPS = 3;
/** テーマ生成の 1 回あたり件数。 */
const PLAN_BOOK_THEME_COUNT = 5;

export const OrgExecutePayloadSchema = z.object({
  job_id: z.string().min(1).optional(),
  trigger: z.string().optional(),
  /** 上限の上書き（テスト/手動用）。 */
  limit: z.number().int().positive().max(50).optional(),
});

// --- 型 ---------------------------------------------------------------------

export interface DispatchTaskRow {
  id: string;
  objective_id: string | null;
  division: string;
  kind: string;
  book_id: string | null;
  instruction: string;
  title: string;
  priority: string;
  depends_on: string[];
  theme_id: string | null;
  account_id: string | null;
  scheduled_for: Date | null;
  created_at: Date;
}

interface FollowUp {
  division: Division;
  kind: string;
  assignee_role: string;
  title: string;
  instruction: string;
  book_id?: string | null;
}

interface HandlerResult {
  result_json: unknown;
  follow_ups?: FollowUp[];
}

export interface OrgExecutePrisma {
  orgTask: {
    findMany: (args: unknown) => Promise<DispatchTaskRow[] | Array<{ id: string }>>;
    updateMany: (args: {
      where: { id: string; status: string };
      data: { status: string; updated_at?: Date };
    }) => Promise<{ count: number }>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<unknown>;
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
  book: {
    findMany: (args: unknown) => Promise<
      Array<{ id: string; title: string; status: string; publish_status: string; theme: { genre: string } | null }>
    >;
    findUnique: (args: unknown) => Promise<
      | {
          id: string;
          title: string;
          subtitle: string | null;
          theme: { genre: string } | null;
          kdpMetadata: { description: string | null; keywords: unknown; price_jpy: unknown } | null;
          outline: { chapters_json: unknown } | null;
        }
      | null
    >;
  };
  salesRecord: {
    findMany: (args: unknown) => Promise<
      Array<{ book_id: string; year_month: string; royalty_jpy: unknown; book: { title: string; theme: { genre: string } | null } | null }>
    >;
  };
  themeCandidate: {
    findUnique: (args: {
      where: { id: string };
      select: { id: true; account_id: true; status: true };
    }) => Promise<{ id: string; account_id: string | null; status: string } | null>;
  };
  account: {
    findFirst: (args: unknown) => Promise<{ id: string } | null>;
  };
  tokenUsage: {
    aggregate: (args: {
      _sum: { cost_jpy: true };
      where: { org_task_id: string };
    }) => Promise<{ _sum: { cost_jpy: unknown } }>;
  };
  job: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
    findMany?: (args: unknown) => Promise<
      Array<{ id: string; kind: string; status: string; retries: number; payload_json: unknown }>
    >;
    update?: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<unknown>;
  };
  // P3 promotion 効果検証（analyze_promo）用。
  promotionPost?: {
    findMany: (args: unknown) => Promise<
      Array<{ book_id: string; channel: string; status: string; book: { title: string; theme: { genre: string } | null } | null }>
    >;
  };
  promotionChannelSetting?: {
    findMany: (args: unknown) => Promise<Array<{ channel: string; auto_enabled: boolean }>>;
  };
  // P4 アカウント戦略（plan_accounts）用の台帳。
  promotionAccount?: {
    findMany: (args: unknown) => Promise<
      Array<{ channel: string; niche: string; handle: string | null; status: string }>
    >;
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
}

type AnalyzeSalesFn = (input: SalesAnalystInput, deps?: SalesAnalystDeps) => Promise<SalesAnalysisOutput>;
type ResearchMarketFn = (input: MarketAnalystInput, deps?: MarketAnalystDeps) => Promise<MarketResearchOutput>;
type DraftMetadataFn = (input: MetadataWorkerInput, deps?: MetadataWorkerDeps) => Promise<MetadataDraftOutput>;
type AnalyzePromotionFn = (input: PromoAnalystInput, deps?: PromoAnalystDeps) => Promise<PromoAnalysisOutput>;
type ReviewCostsFn = (input: CostAccountantInput, deps?: CostAccountantDeps) => Promise<CostReportOutput>;
type PlanAccountStrategyFn = (
  input: AccountStrategistInput,
  deps?: AccountStrategistDeps,
) => Promise<AccountStrategyOutput>;

export interface OrgExecuteDeps {
  prisma?: OrgExecutePrisma;
  logger?: Logger;
  analyzeSales?: AnalyzeSalesFn;
  researchMarket?: ResearchMarketFn;
  draftMetadata?: DraftMetadataFn;
  analyzePromotion?: AnalyzePromotionFn;
  reviewCosts?: ReviewCostsFn;
  planAccountStrategy?: PlanAccountStrategyFn;
  enqueueJob?: EnqueueJobLike;
  now?: () => Date;
  genId?: () => string;
}

export interface OrgExecuteResult {
  dispatched: number;
  done: number;
  blocked: number;
  follow_ups_created: number;
  by_kind: Record<string, number>;
}

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function periodLabel(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** 改善示唆 → 起票可能な改善ToDo(FollowUp) に写像（本部の既定 kind/担当へ）。 */
function suggestionsToFollowUps(suggestions: AnalysisSuggestion[]): FollowUp[] {
  const out: FollowUp[] = [];
  for (const s of suggestions) {
    const division = s.division;
    const kind = DIVISION_DEFAULT_KIND[division];
    if (!kind || !(DIVISION_KINDS[division] as readonly string[]).includes(kind)) continue;
    out.push({
      division,
      kind,
      assignee_role: DIVISION_DEFAULT_ASSIGNEE[division],
      title: s.action.slice(0, 140),
      instruction: `${s.action}${s.rationale ? `\n\n根拠: ${s.rationale}` : ''}`.slice(0, 3900),
    });
    if (out.length >= MAX_FOLLOWUPS) break;
  }
  return out;
}

// --- スナップショット構築 ----------------------------------------------------

async function buildSalesSnapshot(prisma: OrgExecutePrisma, now: Date, instruction: string) {
  const sales = await prisma.salesRecord.findMany({
    select: {
      book_id: true,
      year_month: true,
      royalty_jpy: true,
      book: { select: { title: true, theme: { select: { genre: true } } } },
    },
  });
  const books = await prisma.book.findMany({
    select: { id: true, title: true, status: true, publish_status: true, theme: { select: { genre: true } } },
  });

  const total = sales.reduce((a, r) => a + toNumber(r.royalty_jpy), 0);
  const maxMonth = sales.reduce((m, r) => (r.year_month > m ? r.year_month : m), '');
  const lastMonth = sales.filter((r) => r.year_month === maxMonth).reduce((a, r) => a + toNumber(r.royalty_jpy), 0);

  const monthMap = new Map<string, number>();
  for (const r of sales) monthMap.set(r.year_month, (monthMap.get(r.year_month) ?? 0) + toNumber(r.royalty_jpy));
  const months = [...monthMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([year_month, royalty_jpy]) => ({ year_month, royalty_jpy }));

  const bookMap = new Map<string, { title: string; royalty: number; genre: string | null }>();
  for (const r of sales) {
    const cur = bookMap.get(r.book_id) ?? {
      title: r.book?.title ?? '(不明)',
      royalty: 0,
      genre: r.book?.theme?.genre ?? null,
    };
    cur.royalty += toNumber(r.royalty_jpy);
    bookMap.set(r.book_id, cur);
  }
  const perBook = [...bookMap.values()]
    .sort((a, b) => b.royalty - a.royalty)
    .map((x) => ({ title: x.title, royalty_jpy: x.royalty, genre: x.genre }));

  return {
    period_label: periodLabel(now),
    total_royalty_jpy: total,
    last_month_royalty_jpy: lastMonth,
    months,
    per_book: perBook,
    published_count: books.filter((b) => b.publish_status === 'published').length,
    instruction,
  };
}

async function buildMarketContext(prisma: OrgExecutePrisma, now: Date, instruction: string) {
  const books = await prisma.book.findMany({
    select: { id: true, title: true, status: true, publish_status: true, theme: { select: { genre: true } } },
  });
  const inventory: Record<string, number> = {};
  for (const b of books) {
    const g = b.theme?.genre ?? '未分類';
    inventory[g] = (inventory[g] ?? 0) + 1;
  }
  const sales = await prisma.salesRecord.findMany({
    select: {
      book_id: true,
      year_month: true,
      royalty_jpy: true,
      book: { select: { title: true, theme: { select: { genre: true } } } },
    },
  });
  const bookMap = new Map<string, { title: string; royalty: number; genre: string | null }>();
  for (const r of sales) {
    const cur = bookMap.get(r.book_id) ?? { title: r.book?.title ?? '(不明)', royalty: 0, genre: r.book?.theme?.genre ?? null };
    cur.royalty += toNumber(r.royalty_jpy);
    bookMap.set(r.book_id, cur);
  }
  const top = [...bookMap.values()]
    .sort((a, b) => b.royalty - a.royalty)
    .slice(0, 10)
    .map((x) => ({ title: x.title, royalty_jpy: x.royalty, genre: x.genre }));

  return { period_label: periodLabel(now), instruction, genre_inventory: inventory, top_books: top };
}

// --- ハンドラ ---------------------------------------------------------------

interface HandlerCtx {
  prisma: OrgExecutePrisma;
  deps: Required<
    Pick<
      OrgExecuteDeps,
      | 'analyzeSales'
      | 'researchMarket'
      | 'draftMetadata'
      | 'analyzePromotion'
      | 'reviewCosts'
      | 'planAccountStrategy'
      | 'enqueueJob'
      | 'now'
      | 'genId'
    >
  >;
  log: Logger;
}

async function handleAnalyzeSales(task: DispatchTaskRow, ctx: HandlerCtx): Promise<HandlerResult> {
  const snapshot = await buildSalesSnapshot(ctx.prisma, ctx.deps.now(), task.instruction);
  const out = await ctx.deps.analyzeSales({ snapshot }, { orgTaskId: task.id });
  return { result_json: out, follow_ups: suggestionsToFollowUps(out.suggestions) };
}

async function handleResearchMarket(task: DispatchTaskRow, ctx: HandlerCtx): Promise<HandlerResult> {
  const context = await buildMarketContext(ctx.prisma, ctx.deps.now(), task.instruction);
  const out = await ctx.deps.researchMarket({ context }, { orgTaskId: task.id });
  // theme_ideas → 制作の企画(plan_book) 改善ToDo に写像 + 明示的 suggestions も追加。
  const themeFollowUps: FollowUp[] = out.theme_ideas.slice(0, MAX_FOLLOWUPS).map((t) => ({
    division: 'production' as Division,
    kind: DIVISION_DEFAULT_KIND.production,
    assignee_role: DIVISION_DEFAULT_ASSIGNEE.production,
    title: `企画候補: ${t.title}`.slice(0, 140),
    instruction: `テーマ案「${t.title}」${t.angle ? `\n切り口: ${t.angle}` : ''}`.slice(0, 3900),
  }));
  const followUps = [...themeFollowUps, ...suggestionsToFollowUps(out.suggestions)].slice(0, MAX_FOLLOWUPS);
  return { result_json: out, follow_ups: followUps };
}

async function handlePrepareMetadata(task: DispatchTaskRow, ctx: HandlerCtx, priceFocus: boolean): Promise<HandlerResult> {
  if (!task.book_id) {
    throw new Error('prepare_metadata/set_price には book_id が必要です（対象書籍未指定）');
  }
  const book = await ctx.prisma.book.findUnique({
    where: { id: task.book_id },
    select: {
      id: true,
      title: true,
      subtitle: true,
      theme: { select: { genre: true } },
      kdpMetadata: { select: { description: true, keywords: true, price_jpy: true } },
      outline: { select: { chapters_json: true } },
    },
  });
  if (!book) throw new Error(`book not found: ${task.book_id}`);

  const chapters = Array.isArray(book.outline?.chapters_json)
    ? (book.outline?.chapters_json as Array<{ title?: string }>)
    : [];
  const outlineSummary = chapters.map((c) => c?.title).filter(Boolean).join(' / ') || null;
  const kw = Array.isArray(book.kdpMetadata?.keywords) ? (book.kdpMetadata?.keywords as string[]) : null;

  const out = await ctx.deps.draftMetadata(
    {
      context: {
        book: {
          title: book.title,
          subtitle: book.subtitle,
          genre: book.theme?.genre ?? null,
          outline_summary: outlineSummary,
        },
        instruction: task.instruction,
        existing: book.kdpMetadata
          ? {
              description: book.kdpMetadata.description,
              keywords: kw,
              price_jpy: book.kdpMetadata.price_jpy != null ? toNumber(book.kdpMetadata.price_jpy) : null,
            }
          : null,
        price_focus: priceFocus,
      },
    },
    { orgTaskId: task.id },
  );
  return { result_json: { draft: out, note: '草案のみ。KdpMetadata への反映と KDP 公開は人手承認ゲート。' } };
}

async function resolveAccountId(
  prisma: OrgExecutePrisma,
  preferred: string | null,
): Promise<string> {
  if (preferred) {
    const acc = await prisma.account.findFirst({ where: { id: preferred }, select: { id: true } });
    if (acc) return acc.id;
  }
  const first = await prisma.account.findFirst({
    where: { status: 'active' },
    select: { id: true },
    orderBy: { created_at: 'asc' },
  });
  if (!first) throw new Error('有効な KDP アカウントがありません（先にアカウントを接続してください）');
  return first.id;
}

async function handlePlanBook(task: DispatchTaskRow, ctx: HandlerCtx): Promise<HandlerResult> {
  const accountId = await resolveAccountId(ctx.prisma, task.account_id);
  const themeSessionId = ctx.deps.genId();
  const jobPayload = {
    theme_session_id: themeSessionId,
    account_id: accountId,
    genre: null,
    keyword_or_brief: task.instruction.slice(0, 500),
    count: PLAN_BOOK_THEME_COUNT,
  };
  const job = await ctx.prisma.job.create({
    data: { kind: PIPELINE_THEME_GENERATE_TASK_NAME, status: 'queued', payload_json: jobPayload },
  });
  await ctx.deps.enqueueJob(PIPELINE_THEME_GENERATE_TASK_NAME, {
    theme_session_id: themeSessionId,
    job_id: job.id,
  });
  return {
    result_json: {
      action: 'theme_generate_enqueued',
      theme_session_id: themeSessionId,
      job_id: job.id,
      account_id: accountId,
      count: PLAN_BOOK_THEME_COUNT,
    },
  };
}

async function handleWrite(task: DispatchTaskRow, ctx: HandlerCtx): Promise<HandlerResult> {
  if (!task.theme_id) {
    throw new Error('write には承認済みテーマ(theme_id)が必要です。plan_book→テーマ承認後に theme_id を設定して再起票してください。');
  }
  const theme = await ctx.prisma.themeCandidate.findUnique({
    where: { id: task.theme_id },
    select: { id: true, account_id: true, status: true },
  });
  if (!theme) throw new Error(`theme not found: ${task.theme_id}`);

  const accountId = await resolveAccountId(ctx.prisma, task.account_id ?? theme.account_id);
  const jobPayload = { theme_id: theme.id, account_id: accountId };
  const job = await ctx.prisma.job.create({
    data: { kind: PIPELINE_BOOK_KICKOFF_TASK_NAME, status: 'queued', payload_json: jobPayload },
  });
  await ctx.deps.enqueueJob(PIPELINE_BOOK_KICKOFF_TASK_NAME, {
    theme_id: theme.id,
    account_id: accountId,
    job_id: job.id,
  });
  return {
    result_json: { action: 'book_kickoff_enqueued', theme_id: theme.id, account_id: accountId, job_id: job.id },
  };
}

// --- P3 promotion（販促の org 統合） --------------------------------------

/** create_content — 本の販促プラン生成(promoter)＋投稿キュー生成を既存パイプラインで起動。 */
async function handleCreateContent(task: DispatchTaskRow, ctx: HandlerCtx): Promise<HandlerResult> {
  if (!task.book_id) {
    throw new Error('create_content には book_id が必要です（対象書籍未指定）');
  }
  const jobPayload = { book_id: task.book_id };
  const job = await ctx.prisma.job.create({
    data: { kind: PIPELINE_BOOK_PROMOTION_GENERATE_TASK_NAME, book_id: task.book_id, status: 'queued', payload_json: jobPayload },
  });
  await ctx.deps.enqueueJob(PIPELINE_BOOK_PROMOTION_GENERATE_TASK_NAME, { book_id: task.book_id, job_id: job.id });
  return {
    result_json: { action: 'promotion_generate_enqueued', book_id: task.book_id, job_id: job.id },
  };
}

/** publish_post — 期限到来した投稿を配信（既存 promotion.dispatch を起動）。auto_enabled チャンネルのみ実投稿。 */
async function handlePublishPost(_task: DispatchTaskRow, ctx: HandlerCtx): Promise<HandlerResult> {
  await ctx.deps.enqueueJob(PROMOTION_DISPATCH_TASK_NAME, {});
  return {
    result_json: {
      action: 'promotion_dispatch_enqueued',
      note: 'auto_enabled チャンネルかつ出版済みの本の、期限到来した予約投稿を配信します。',
    },
  };
}

async function buildPromoSnapshot(prisma: OrgExecutePrisma, now: Date, instruction: string) {
  const posts = prisma.promotionPost
    ? await prisma.promotionPost.findMany({
        select: {
          book_id: true,
          channel: true,
          status: true,
          book: { select: { title: true, theme: { select: { genre: true } } } },
        },
      })
    : [];
  const channelSettings = prisma.promotionChannelSetting
    ? await prisma.promotionChannelSetting.findMany({ select: { channel: true, auto_enabled: true } })
    : [];
  const sales = await prisma.salesRecord.findMany({
    select: {
      book_id: true,
      year_month: true,
      royalty_jpy: true,
      book: { select: { title: true, theme: { select: { genre: true } } } },
    },
  });

  const isPosted = (s: string) => s === 'posted';
  const isFailed = (s: string) => s === 'failed';
  const isScheduled = (s: string) => s === 'scheduled' || s === 'draft' || s === 'posting';

  const chAuto = new Map(channelSettings.map((c) => [c.channel, c.auto_enabled]));
  const chAgg = new Map<string, { posted: number; scheduled: number; failed: number }>();
  const bookAgg = new Map<string, { title: string; posted: number; genre: string | null }>();
  let totalPosted = 0;
  let totalFailed = 0;
  for (const p of posts) {
    const c = chAgg.get(p.channel) ?? { posted: 0, scheduled: 0, failed: 0 };
    if (isPosted(p.status)) {
      c.posted += 1;
      totalPosted += 1;
    } else if (isFailed(p.status)) {
      c.failed += 1;
      totalFailed += 1;
    } else if (isScheduled(p.status)) {
      c.scheduled += 1;
    }
    chAgg.set(p.channel, c);

    const b = bookAgg.get(p.book_id) ?? { title: p.book?.title ?? '(不明)', posted: 0, genre: p.book?.theme?.genre ?? null };
    if (isPosted(p.status)) b.posted += 1;
    bookAgg.set(p.book_id, b);
  }

  const royaltyByBook = new Map<string, number>();
  for (const r of sales) royaltyByBook.set(r.book_id, (royaltyByBook.get(r.book_id) ?? 0) + toNumber(r.royalty_jpy));

  const channels = [...new Set([...chAgg.keys(), ...chAuto.keys()])].map((channel) => {
    const a = chAgg.get(channel) ?? { posted: 0, scheduled: 0, failed: 0 };
    return { channel, posted: a.posted, scheduled: a.scheduled, failed: a.failed, auto_enabled: chAuto.get(channel) ?? false };
  });

  const bookIds = new Set<string>([...bookAgg.keys(), ...royaltyByBook.keys()]);
  const perBook = [...bookIds]
    .map((id) => {
      const b = bookAgg.get(id);
      return {
        title: b?.title ?? '(不明)',
        posted: b?.posted ?? 0,
        royalty_jpy: royaltyByBook.get(id) ?? 0,
        genre: b?.genre ?? null,
      };
    })
    .sort((a, b) => b.royalty_jpy - a.royalty_jpy);

  return {
    period_label: periodLabel(now),
    channels,
    per_book: perBook,
    total_posted: totalPosted,
    total_failed: totalFailed,
    instruction,
  };
}

async function handleAnalyzePromo(task: DispatchTaskRow, ctx: HandlerCtx): Promise<HandlerResult> {
  const snapshot = await buildPromoSnapshot(ctx.prisma, ctx.deps.now(), task.instruction);
  const out = await ctx.deps.analyzePromotion({ snapshot }, { orgTaskId: task.id });
  return { result_json: out, follow_ups: suggestionsToFollowUps(out.suggestions) };
}

/** ニッチ文字列の正規化（重複アカウント判定用）。 */
function normalizeNiche(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * plan_accounts (P4) — 多アカウント運用の戦略を自律立案。
 * 新規アカウント作成そのものは規約/KYC のため org は行わず、作成仕様を埋めた
 * `create_account`(needs_human) を起票＋台帳(promotion_accounts, pending)に登録する。
 */
async function handlePlanAccounts(task: DispatchTaskRow, ctx: HandlerCtx): Promise<HandlerResult> {
  const now = ctx.deps.now();

  // 既存の接続済みチャンネル（channel×1 の v1 設定）。
  const channelSettings = ctx.prisma.promotionChannelSetting
    ? ((await ctx.prisma.promotionChannelSetting.findMany({
        select: { channel: true, auto_enabled: true, handle: true, token_mask: true },
      })) as unknown as Array<{ channel: string; handle: string | null; token_mask: string | null }>)
    : [];
  // 既存の台帳アカウント（多アカウント）。
  const ledger = ctx.prisma.promotionAccount
    ? await ctx.prisma.promotionAccount.findMany({
        where: { status: { in: ['pending', 'connected'] } },
        select: { channel: true, niche: true, handle: true, status: true },
      })
    : [];

  const connected = [
    ...channelSettings
      .filter((c) => c.handle || c.token_mask)
      .map((c) => ({ channel: c.channel, handle: c.handle, niche: null as string | null })),
    ...ledger.filter((a) => a.status === 'connected').map((a) => ({ channel: a.channel, handle: a.handle, niche: a.niche })),
  ];
  const pending = ledger.filter((a) => a.status === 'pending').map((a) => ({ channel: a.channel, niche: a.niche }));

  // 在庫本のジャンル内訳＋ターゲットサンプル。
  const books = (await ctx.prisma.book.findMany({
    select: { id: true, theme: { select: { genre: true, target_reader: true } } },
  })) as unknown as Array<{ theme: { genre: string; target_reader: string | null } | null }>;
  const inventory: Record<string, number> = {};
  const targetSet = new Set<string>();
  for (const b of books) {
    const g = b.theme?.genre ?? '未分類';
    inventory[g] = (inventory[g] ?? 0) + 1;
    if (b.theme?.target_reader) targetSet.add(b.theme.target_reader.slice(0, 120));
  }

  const out = await ctx.deps.planAccountStrategy(
    {
      snapshot: {
        period_label: periodLabel(now),
        connected,
        pending,
        genre_inventory: inventory,
        target_samples: [...targetSet],
        instruction: task.instruction,
      },
    },
    { orgTaskId: task.id },
  );

  // 既存（台帳）ニッチ集合 — 重複起票を避ける。
  const existingKeys = new Set(ledger.map((a) => `${a.channel}::${normalizeNiche(a.niche)}`));
  let accountsCreated = 0;
  for (const rec of out.recommended_accounts) {
    const key = `${rec.channel}::${normalizeNiche(rec.niche)}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    // 台帳へ pending 登録（作成仕様を保持）。
    if (ctx.prisma.promotionAccount) {
      await ctx.prisma.promotionAccount.create({
        data: {
          channel: rec.channel,
          niche: rec.niche,
          target_reader: rec.target_reader || null,
          bio: rec.bio || null,
          posting_policy: rec.posting_policy || null,
          status: 'pending',
        },
      });
    }

    // 作成仕様を埋めた create_account を needs_human で起票（作成そのものは人手）。
    const instruction = [
      `【${rec.channel} 新規アカウント作成依頼】ニッチ: ${rec.niche}`,
      rec.target_reader ? `ターゲット: ${rec.target_reader}` : '',
      rec.handle_suggestion ? `推奨ハンドル案: @${rec.handle_suggestion}` : '',
      rec.bio ? `\nプロフィール文（そのまま貼付可）:\n${rec.bio}` : '',
      rec.posting_policy ? `\n投稿方針:\n${rec.posting_policy}` : '',
      rec.rationale ? `\n狙い: ${rec.rationale}` : '',
      '\n※ 規約/本人確認のためアカウント作成・接続は運営者が一度だけ行ってください。接続後は org が自動運用します。',
    ]
      .filter((l) => l !== '')
      .join('\n')
      .slice(0, 3900);
    await ctx.prisma.orgTask.create({
      data: {
        objective_id: task.objective_id,
        parent_id: task.id,
        division: 'promotion',
        owner_role: 'promo_mgr',
        assignee_role: 'human',
        channel: rec.channel,
        kind: 'create_account',
        title: `アカウント作成: ${rec.channel} / ${rec.niche}`.slice(0, 160),
        instruction,
        status: 'needs_human',
        priority: 'should',
        result_json: { spec: rec },
      },
    });
    accountsCreated += 1;
  }

  return {
    result_json: {
      action: 'account_strategy_planned',
      strategy: out,
      accounts_proposed: accountsCreated,
      note: '推奨アカウントは台帳(pending)に登録し、作成仕様付きで create_account(要人手)を起票。',
    },
    follow_ups: suggestionsToFollowUps(out.suggestions),
  };
}

// --- P3 sysops（自己復旧） --------------------------------------------------

/** recover_job — 対象書籍の最進捗の失敗パイプラインジョブを再投入する。 */
async function handleRecoverJob(task: DispatchTaskRow, ctx: HandlerCtx): Promise<HandlerResult> {
  if (!task.book_id) {
    throw new Error('recover_job には対象書籍(book_id)が必要です');
  }
  if (!ctx.prisma.job.findMany) {
    throw new Error('job.findMany 未提供（recover_job の対象探索に必須）');
  }
  const failed = await ctx.prisma.job.findMany({
    where: { book_id: task.book_id, status: 'failed', kind: { startsWith: 'pipeline.book.' } },
    select: { id: true, kind: true, status: true, retries: true, payload_json: true },
  });
  if (failed.length === 0) {
    throw new Error(`復旧対象の失敗ジョブがありません（book=${task.book_id}）`);
  }
  const stepIndex = (kind: string) => {
    const i = PIPELINE_STEP_ORDER.indexOf(kind);
    return i >= 0 ? i : -1;
  };
  const target = failed.reduce((best, cur) => (stepIndex(cur.kind) > stepIndex(best.kind) ? cur : best), failed[0]!);

  const base =
    target.payload_json && typeof target.payload_json === 'object' && !Array.isArray(target.payload_json)
      ? (() => {
          const { job_id: _drop, ...rest } = target.payload_json as Record<string, unknown>;
          return rest;
        })()
      : {};

  const newJob = await ctx.prisma.job.create({
    data: { kind: target.kind, book_id: task.book_id, status: 'queued', payload_json: { ...base, book_id: task.book_id } },
  });
  await ctx.deps.enqueueJob(target.kind, { ...base, book_id: task.book_id, job_id: newJob.id });
  return {
    result_json: {
      action: 'job_recovered',
      recovered_step: target.kind,
      from_job_id: target.id,
      new_job_id: newJob.id,
      failed_count: failed.length,
    },
  };
}

// --- P3 finance（コスト集計/ROI） -------------------------------------------

async function handleCostReport(task: DispatchTaskRow, ctx: HandlerCtx): Promise<HandlerResult> {
  const agg = await computeCostAggregate(ctx.prisma as unknown as FinancePrisma, ctx.deps.now());
  const snapshot = aggregateToSnapshot(agg, task.instruction);
  const out = await ctx.deps.reviewCosts({ snapshot }, { orgTaskId: task.id });
  return {
    result_json: {
      report: out,
      aggregate: {
        period_label: agg.period_label,
        total_cost_jpy: agg.total_cost_jpy,
        total_royalty_jpy: agg.total_royalty_jpy,
        total_budget_jpy: agg.total_budget_jpy,
        by_division: agg.budget_lines,
        per_book: agg.per_book.slice(0, 20),
      },
    },
    follow_ups: suggestionsToFollowUps(out.suggestions),
  };
}

async function runHandler(task: DispatchTaskRow, ctx: HandlerCtx): Promise<HandlerResult> {
  switch (task.kind) {
    case 'analyze_sales':
    case 'report':
      return handleAnalyzeSales(task, ctx);
    case 'research_market':
      return handleResearchMarket(task, ctx);
    case 'prepare_metadata':
      return handlePrepareMetadata(task, ctx, false);
    case 'set_price':
      return handlePrepareMetadata(task, ctx, true);
    case 'plan_book':
      return handlePlanBook(task, ctx);
    case 'write':
      return handleWrite(task, ctx);
    // P4 promotion
    case 'plan_accounts':
      return handlePlanAccounts(task, ctx);
    // P3 promotion
    case 'create_content':
      return handleCreateContent(task, ctx);
    case 'publish_post':
      return handlePublishPost(task, ctx);
    case 'analyze_promo':
      return handleAnalyzePromo(task, ctx);
    // P3 sysops
    case 'recover_job':
      return handleRecoverJob(task, ctx);
    // P3 finance
    case 'cost_report':
    case 'budget_review':
      return handleCostReport(task, ctx);
    default:
      throw new Error(`dispatch 未対応の kind: ${task.kind}`);
  }
}

// --- 本体 -------------------------------------------------------------------

export async function runOrgExecute(payload: unknown, deps: OrgExecuteDeps = {}): Promise<OrgExecuteResult> {
  const parsed = OrgExecutePayloadSchema.safeParse(payload ?? {});
  const jobId = parsed.success ? parsed.data.job_id : undefined;
  const limit = (parsed.success && parsed.data.limit) || MAX_DISPATCH_PER_RUN;

  const log = deps.logger ?? createLogger(`worker.${ORG_EXECUTE_DISPATCH_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as OrgExecutePrisma);
  const now = deps.now ?? (() => new Date());
  const ctx: HandlerCtx = {
    prisma,
    log,
    deps: {
      analyzeSales: deps.analyzeSales ?? defaultAnalyzeSales,
      researchMarket: deps.researchMarket ?? defaultResearchMarket,
      draftMetadata: deps.draftMetadata ?? defaultDraftMetadata,
      analyzePromotion: deps.analyzePromotion ?? defaultAnalyzePromotion,
      reviewCosts: deps.reviewCosts ?? defaultReviewCosts,
      planAccountStrategy: deps.planAccountStrategy ?? defaultPlanAccountStrategy,
      enqueueJob:
        deps.enqueueJob ??
        (() => {
          throw new Error('enqueueJob (helpers.addJob) が未提供です（plan_book/write の起動に必須）');
        }),
      now,
      genId: deps.genId ?? (() => randomUUID()),
    },
  };

  const result: OrgExecuteResult = { dispatched: 0, done: 0, blocked: 0, follow_ups_created: 0, by_kind: {} };

  try {
    // 1. 候補: approved かつ dispatchable kind。期限(scheduled_for)到来のもの。
    const candidatesRaw = (await prisma.orgTask.findMany({
      where: {
        status: 'approved',
        kind: { in: [...DISPATCHABLE_KINDS] },
      },
      select: {
        id: true,
        objective_id: true,
        division: true,
        kind: true,
        book_id: true,
        instruction: true,
        title: true,
        priority: true,
        depends_on: true,
        theme_id: true,
        account_id: true,
        scheduled_for: true,
        created_at: true,
      },
      orderBy: { created_at: 'asc' },
    })) as DispatchTaskRow[];

    const nowTs = now();
    const scheduled = candidatesRaw.filter((t) => !t.scheduled_for || t.scheduled_for <= nowTs);

    // 2. 依存充足チェック: 依存タスクが全て done か。
    const depIds = [...new Set(scheduled.flatMap((t) => t.depends_on ?? []))];
    const doneIds = new Set<string>();
    if (depIds.length > 0) {
      const doneRows = (await prisma.orgTask.findMany({
        where: { id: { in: depIds }, status: 'done' },
        select: { id: true },
      })) as Array<{ id: string }>;
      for (const r of doneRows) doneIds.add(r.id);
    }

    const ready = scheduled
      .filter((t) => depsSatisfied(t, doneIds))
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || (a.created_at < b.created_at ? -1 : 1))
      .slice(0, limit);

    // 3. 各タスクを実行。
    for (const task of ready) {
      // CAS: approved → in_progress（同時実行での二重処理を防ぐ）。
      const claim = await prisma.orgTask.updateMany({
        where: { id: task.id, status: 'approved' },
        data: { status: 'in_progress', updated_at: now() },
      });
      if (claim.count === 0) continue; // 他ワーカーが確保済み
      result.dispatched += 1;
      result.by_kind[task.kind] = (result.by_kind[task.kind] ?? 0) + 1;

      try {
        const handlerResult = await runHandler(task, ctx);

        // コスト実績を集計して確定。
        const costAgg = await prisma.tokenUsage.aggregate({
          _sum: { cost_jpy: true },
          where: { org_task_id: task.id },
        });
        const costJpy = toNumber(costAgg._sum.cost_jpy);

        await prisma.orgTask.update({
          where: { id: task.id },
          data: {
            status: 'done',
            done_at: now(),
            result_json: handlerResult.result_json as object,
            cost_jpy: costJpy,
            error: null,
          },
        });
        result.done += 1;

        // 連鎖起票（改善ToDo, proposed）。
        for (const fu of handlerResult.follow_ups ?? []) {
          await prisma.orgTask.create({
            data: {
              objective_id: task.objective_id,
              parent_id: task.id,
              division: fu.division,
              book_id: fu.book_id ?? null,
              owner_role: task.division === 'analytics' ? 'analytics_mgr' : 'ceo',
              assignee_role: fu.assignee_role,
              kind: fu.kind,
              title: fu.title,
              instruction: fu.instruction,
              status: 'proposed',
              priority: 'should',
            },
          });
          result.follow_ups_created += 1;
        }
        log.info({ task: ORG_EXECUTE_DISPATCH_TASK_NAME, id: task.id, kind: task.kind, cost_jpy: costJpy }, 'task done');
      } catch (err) {
        await prisma.orgTask.update({
          where: { id: task.id },
          data: { status: 'blocked', error: serializeError(err) },
        });
        result.blocked += 1;
        log.warn({ task: ORG_EXECUTE_DISPATCH_TASK_NAME, id: task.id, kind: task.kind, err }, 'task blocked');
      }
    }

    if (jobId && prisma.job.update) {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'done', finished_at: now(), error: null, result_json: result },
      });
    }
    log.info({ task: ORG_EXECUTE_DISPATCH_TASK_NAME, ...result }, 'org.execute.dispatch done');
    return result;
  } catch (err) {
    if (jobId && prisma.job.update) {
      try {
        await prisma.job.update({
          where: { id: jobId },
          data: { status: 'failed', finished_at: now(), error: serializeError(err) },
        });
      } catch {
        // best-effort
      }
    }
    throw err;
  }
}

export const orgExecuteDispatchTask: Task = async (payload: unknown, helpers: JobHelpers) => {
  const enqueueJob: EnqueueJobLike = (taskName, p) =>
    helpers.addJob(taskName, p as Record<string, unknown> | undefined, { maxAttempts: 3 });
  await runOrgExecute(payload, { enqueueJob });
};
