/**
 * docs/06 P3 §9 — 経営管理（コスト集計）の共有ロジック。
 *
 * token_usage を「本部別 / 書籍別」に集計し、Objective の予算配分・月次上限と突き合わせる。
 * `org.execute.dispatch` の cost_report ハンドラ（講評はコスト会計エージェント）と
 * `org.finance.tick`（予算ガード）が共有する。決定的処理（LLM 非依存）。
 */
import { DIVISIONS, buildBudgetLines, type Division, type DivisionBudgetLine } from '@a2p/contracts/org';
import type { CostSnapshot } from '@a2p/agents';

function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function financePeriodLabel(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** finance 集計に必要な最小 prisma I/F（テストで差し替え可能に）。 */
export interface FinancePrisma {
  tokenUsage: {
    findMany: (args: {
      where: { created_at: { gte: Date } };
      select: { org_task_id: true; book_id: true; cost_jpy: true };
    }) => Promise<Array<{ org_task_id: string | null; book_id: string | null; cost_jpy: unknown }>>;
  };
  orgTask: {
    findMany: (args: {
      where: { id: { in: string[] } };
      select: { id: true; division: true };
    }) => Promise<Array<{ id: string; division: string }>>;
  };
  book: {
    findMany: (args: {
      select: { id: true; title: true; theme: { select: { genre: true } } };
    }) => Promise<Array<{ id: string; title: string; theme: { genre: string } | null }>>;
  };
  salesRecord: {
    findMany: (args: {
      select: { book_id: true; royalty_jpy: true };
    }) => Promise<Array<{ book_id: string; royalty_jpy: unknown }>>;
  };
  orgObjective: {
    findFirst: (args: {
      where: { status: string };
      select: { budget_jpy: true; budget_allocation_json: true };
      orderBy: { created_at: 'desc' };
    }) => Promise<{ budget_jpy: number | null; budget_allocation_json: unknown } | null>;
  };
  appSettings: {
    findUnique: (args: {
      where: { id: string };
      select: { monthly_cost_red_jpy: true };
    }) => Promise<{ monthly_cost_red_jpy: number } | null>;
  };
}

export interface CostAggregate {
  period_label: string;
  total_cost_jpy: number;
  total_royalty_jpy: number;
  total_budget_jpy: number | null;
  monthly_budget_jpy: number | null;
  allocation: Partial<Record<Division, number>> | null;
  spent_by_division: Partial<Record<Division, number>>;
  budget_lines: DivisionBudgetLine[];
  per_book: Array<{ title: string; cost_jpy: number; royalty_jpy: number; roi: number | null; genre: string | null }>;
}

function normalizeAllocation(v: unknown): Partial<Record<Division, number>> | null {
  if (!v || typeof v !== 'object') return null;
  const rec = v as Record<string, unknown>;
  const out: Partial<Record<Division, number>> = {};
  for (const d of DIVISIONS) {
    const n = toNumber(rec[d]);
    if (n > 0) out[d] = n;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 当月の token_usage を本部別/書籍別に集計する（決定的）。
 */
export async function computeCostAggregate(prisma: FinancePrisma, now: Date): Promise<CostAggregate> {
  const since = monthStart(now);
  const usage = await prisma.tokenUsage.findMany({
    where: { created_at: { gte: since } },
    select: { org_task_id: true, book_id: true, cost_jpy: true },
  });

  const total = usage.reduce((a, u) => a + toNumber(u.cost_jpy), 0);

  // 本部別: token_usage.org_task_id → org_tasks.division。
  const taskIds = [...new Set(usage.map((u) => u.org_task_id).filter((x): x is string => !!x))];
  const divisionByTask = new Map<string, string>();
  if (taskIds.length > 0) {
    const tasks = await prisma.orgTask.findMany({
      where: { id: { in: taskIds } },
      select: { id: true, division: true },
    });
    for (const t of tasks) divisionByTask.set(t.id, t.division);
  }
  const spentByDivision: Partial<Record<Division, number>> = {};
  const costByBook = new Map<string, number>();
  for (const u of usage) {
    const cost = toNumber(u.cost_jpy);
    if (u.org_task_id) {
      const div = divisionByTask.get(u.org_task_id) as Division | undefined;
      if (div) spentByDivision[div] = (spentByDivision[div] ?? 0) + cost;
    }
    if (u.book_id) costByBook.set(u.book_id, (costByBook.get(u.book_id) ?? 0) + cost);
  }

  // 書籍別 ROI（コスト対 売上）。
  const books = await prisma.book.findMany({
    select: { id: true, title: true, theme: { select: { genre: true } } },
  });
  const sales = await prisma.salesRecord.findMany({ select: { book_id: true, royalty_jpy: true } });
  const royaltyByBook = new Map<string, number>();
  for (const s of sales) royaltyByBook.set(s.book_id, (royaltyByBook.get(s.book_id) ?? 0) + toNumber(s.royalty_jpy));
  const totalRoyalty = [...royaltyByBook.values()].reduce((a, b) => a + b, 0);

  const bookMeta = new Map(books.map((b) => [b.id, b]));
  const bookIds = new Set<string>([...costByBook.keys(), ...royaltyByBook.keys()]);
  const perBook = [...bookIds]
    .map((id) => {
      const cost = costByBook.get(id) ?? 0;
      const royalty = royaltyByBook.get(id) ?? 0;
      const meta = bookMeta.get(id);
      return {
        title: meta?.title ?? '(不明)',
        cost_jpy: cost,
        royalty_jpy: royalty,
        roi: cost > 0 ? royalty / cost : null,
        genre: meta?.theme?.genre ?? null,
      };
    })
    .sort((a, b) => (a.roi ?? Infinity) - (b.roi ?? Infinity)); // 低ROI（赤字）を先頭に

  const objective = await prisma.orgObjective.findFirst({
    where: { status: 'active' },
    select: { budget_jpy: true, budget_allocation_json: true },
    orderBy: { created_at: 'desc' },
  });
  const allocation = normalizeAllocation(objective?.budget_allocation_json);
  const settings = await prisma.appSettings.findUnique({
    where: { id: 'singleton' },
    select: { monthly_cost_red_jpy: true },
  });

  return {
    period_label: financePeriodLabel(now),
    total_cost_jpy: Math.round(total),
    total_royalty_jpy: Math.round(totalRoyalty),
    total_budget_jpy: objective?.budget_jpy ?? null,
    monthly_budget_jpy: settings?.monthly_cost_red_jpy ?? null,
    allocation,
    spent_by_division: spentByDivision,
    budget_lines: buildBudgetLines(allocation, spentByDivision),
    per_book: perBook,
  };
}

/** CostAggregate → コスト会計エージェント入力用の CostSnapshot。 */
export function aggregateToSnapshot(agg: CostAggregate, instruction?: string): CostSnapshot {
  return {
    period_label: agg.period_label,
    total_cost_jpy: agg.total_cost_jpy,
    total_royalty_jpy: agg.total_royalty_jpy,
    monthly_budget_jpy: agg.monthly_budget_jpy,
    by_division: agg.budget_lines.map((l) => ({
      division: l.division,
      label: l.label,
      allocated: l.allocated,
      spent: Math.round(l.spent),
      ratio: l.ratio,
    })),
    per_book: agg.per_book.slice(0, 20).map((b) => ({
      title: b.title,
      cost_jpy: Math.round(b.cost_jpy),
      royalty_jpy: Math.round(b.royalty_jpy),
      roi: b.roi,
      genre: b.genre,
    })),
    ...(instruction ? { instruction } : {}),
  };
}
