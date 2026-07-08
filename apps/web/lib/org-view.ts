/**
 * docs/06 — 経営ダッシュボード / 全社ToDoボードのビューモデル。
 * DB 行 → シリアライズ可能な行への変換と、本部別の集計ヘルパー。
 */
import { DIVISIONS, type Division } from '@a2p/contracts/org';

export interface OrgTaskRow {
  id: string;
  division: string;
  bookId: string | null;
  bookTitle: string | null;
  ownerRole: string;
  assigneeRole: string;
  channel: string | null;
  accountRef: string | null;
  kind: string;
  title: string;
  instruction: string;
  status: string;
  priority: string;
  costJpy: number | null;
  createdAt: string | null;
}

export interface DbOrgTask {
  id: string;
  division: string;
  book_id: string | null;
  owner_role: string;
  assignee_role: string;
  channel: string | null;
  account_ref: string | null;
  kind: string;
  title: string;
  instruction: string;
  status: string;
  priority: string;
  cost_jpy: unknown;
  created_at: Date | string | null;
  book?: { title: string } | null;
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function mapOrgTaskRow(t: DbOrgTask): OrgTaskRow {
  return {
    id: t.id,
    division: t.division,
    bookId: t.book_id,
    bookTitle: t.book?.title ?? null,
    ownerRole: t.owner_role,
    assigneeRole: t.assignee_role,
    channel: t.channel,
    accountRef: t.account_ref,
    kind: t.kind,
    title: t.title,
    instruction: t.instruction,
    status: t.status,
    priority: t.priority,
    costJpy: toNum(t.cost_jpy),
    createdAt: t.created_at instanceof Date ? t.created_at.toISOString() : (t.created_at ?? null),
  };
}

/** タスクの cost_jpy を本部別に合算（予算消化の実績値）。 */
export function computeSpentByDivision(tasks: readonly OrgTaskRow[]): Partial<Record<Division, number>> {
  const out: Partial<Record<Division, number>> = {};
  for (const t of tasks) {
    if (!(DIVISIONS as readonly string[]).includes(t.division)) continue;
    const d = t.division as Division;
    out[d] = (out[d] ?? 0) + (t.costJpy ?? 0);
  }
  return out;
}

export interface DivisionCounts {
  open: number;
  human: number;
  done: number;
  total: number;
}

/** 本部別に「進行中 / 要人手 / 完了」を数える。 */
export function divisionTaskCounts(tasks: readonly OrgTaskRow[]): Record<Division, DivisionCounts> {
  const out = {} as Record<Division, DivisionCounts>;
  for (const d of DIVISIONS) out[d] = { open: 0, human: 0, done: 0, total: 0 };
  for (const t of tasks) {
    if (!(DIVISIONS as readonly string[]).includes(t.division)) continue;
    const c = out[t.division as Division];
    c.total += 1;
    if (t.status === 'done') c.done += 1;
    else if (t.status === 'needs_human') c.human += 1;
    else if (t.status !== 'canceled') c.open += 1;
  }
  return out;
}
