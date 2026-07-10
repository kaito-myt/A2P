import { randomUUID } from 'node:crypto';

import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  analyzeSales as defaultAnalyzeSales,
  researchMarket as defaultResearchMarket,
  draftMetadata as defaultDraftMetadata,
  type SalesAnalystInput,
  type SalesAnalystDeps,
  type MarketAnalystInput,
  type MarketAnalystDeps,
  type MetadataWorkerInput,
  type MetadataWorkerDeps,
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
} from '@a2p/contracts/org';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import { PIPELINE_THEME_GENERATE_TASK_NAME } from './pipeline-theme-generate.js';
import { PIPELINE_BOOK_KICKOFF_TASK_NAME } from './pipeline-book-kickoff.js';

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
    update?: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<unknown>;
  };
}

type AnalyzeSalesFn = (input: SalesAnalystInput, deps?: SalesAnalystDeps) => Promise<SalesAnalysisOutput>;
type ResearchMarketFn = (input: MarketAnalystInput, deps?: MarketAnalystDeps) => Promise<MarketResearchOutput>;
type DraftMetadataFn = (input: MetadataWorkerInput, deps?: MetadataWorkerDeps) => Promise<MetadataDraftOutput>;

export interface OrgExecuteDeps {
  prisma?: OrgExecutePrisma;
  logger?: Logger;
  analyzeSales?: AnalyzeSalesFn;
  researchMarket?: ResearchMarketFn;
  draftMetadata?: DraftMetadataFn;
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
  deps: Required<Pick<OrgExecuteDeps, 'analyzeSales' | 'researchMarket' | 'draftMetadata' | 'enqueueJob' | 'now' | 'genId'>>;
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
