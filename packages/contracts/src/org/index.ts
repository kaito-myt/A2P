/**
 * docs/06 — 組織エージェント（全社版）の共有型・定数・スキーマ・ビューヘルパー。
 *
 * CEO → 本部長 → 担当者 の階層と、全社ToDoバックログ (org_tasks) を貫く語彙をここに集約する。
 * DB (packages/db) / agents (packages/agents/src/org) / web (/org) がすべてここを参照する。
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// 本部 (Division)
// ---------------------------------------------------------------------------

export const DIVISIONS = [
  'production',
  'publishing',
  'analytics',
  'promotion',
  'sysops',
  'finance',
] as const;
export type Division = (typeof DIVISIONS)[number];

export const DIVISION_LABELS: Record<Division, string> = {
  production: '制作',
  publishing: '出版',
  analytics: '分析',
  promotion: '販促',
  sysops: '運用',
  finance: '経営管理',
};

/** 各本部を統括する本部長ロール (= agent role / prompts.role)。 */
export const DIVISION_MANAGER_ROLE: Record<Division, string> = {
  production: 'editorial_mgr',
  publishing: 'publish_mgr',
  analytics: 'analytics_mgr',
  promotion: 'promo_mgr',
  sysops: 'ops_mgr',
  finance: 'finance_mgr',
};

/** CEO を含む経営層＋本部長の全 Org ロール（P1 で prompts/model_assignments を持つ）。 */
export const ORG_MANAGER_ROLES = [
  'ceo',
  'editorial_mgr',
  'publish_mgr',
  'analytics_mgr',
  'promo_mgr',
  'ops_mgr',
  'finance_mgr',
] as const;
export type OrgManagerRole = (typeof ORG_MANAGER_ROLES)[number];

export const ORG_ROLE_LABELS: Record<string, string> = {
  ceo: '社長(CEO)',
  editorial_mgr: '制作本部長',
  publish_mgr: '出版本部長',
  analytics_mgr: '分析本部長',
  promo_mgr: '販促本部長',
  ops_mgr: '運用本部長',
  finance_mgr: '経営管理(CFO)',
  // 担当者(P2以降で実行) — 表示用
  marketer: '企画担当',
  writer: '執筆担当',
  editor: '編集担当',
  thumbnail: '表紙担当',
  quality_judge: '品質担当',
  metadata_worker: '入稿担当',
  publish_worker: '公開担当',
  sales_analyst: '売上アナリスト',
  market_analyst: '市場アナリスト',
  content_creator: 'コンテンツ担当',
  publisher_worker: '投稿担当',
  promo_analyst: '販促アナリスト',
  ops_worker: '運用担当',
  cost_accountant: 'コスト会計',
  human: '運営者(人手)',
};

export function orgRoleLabel(role: string): string {
  return ORG_ROLE_LABELS[role] ?? role;
}

// ---------------------------------------------------------------------------
// タスク種別 (kind) — 本部別の動詞
// ---------------------------------------------------------------------------

export const DIVISION_KINDS: Record<Division, readonly string[]> = {
  production: ['plan_book', 'write', 'edit', 'design_cover', 'qa'],
  publishing: ['prepare_metadata', 'set_price', 'publish_kdp'],
  analytics: ['analyze_sales', 'research_market', 'report'],
  promotion: ['create_content', 'publish_post', 'analyze_promo', 'create_account', 'connect_account'],
  sysops: ['monitor', 'recover_job', 'triage_error'],
  finance: ['budget_review', 'cost_report', 'enforce_limit'],
};

export const KIND_LABELS: Record<string, string> = {
  plan_book: '企画',
  write: '執筆',
  edit: '編集',
  design_cover: '表紙作成',
  qa: '品質判定',
  prepare_metadata: 'メタデータ整備',
  set_price: '価格設定',
  publish_kdp: 'KDP公開',
  analyze_sales: '売上分析',
  research_market: '市場リサーチ',
  report: 'レポート',
  create_content: 'コンテンツ作成',
  publish_post: '投稿',
  analyze_promo: '効果検証',
  create_account: 'アカウント作成',
  connect_account: 'アカウント接続',
  monitor: '監視',
  recover_job: 'ジョブ復旧',
  triage_error: 'エラー対応',
  budget_review: '予算レビュー',
  cost_report: 'コスト集計',
  enforce_limit: '予算ガード',
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** 実行に人手を要する種別 → 起票時 status='needs_human'。 */
export const HUMAN_KINDS = new Set<string>(['create_account', 'connect_account', 'publish_kdp']);

export function isHumanKind(kind: string): boolean {
  return HUMAN_KINDS.has(kind);
}

// ---------------------------------------------------------------------------
// 状態・優先度
// ---------------------------------------------------------------------------

export const TASK_STATUSES = [
  'proposed',
  'approved',
  'in_progress',
  'blocked',
  'needs_human',
  'done',
  'canceled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  proposed: '提案',
  approved: '承認済',
  in_progress: '実行中',
  blocked: 'ブロック',
  needs_human: '要人手',
  done: '完了',
  canceled: '取消',
};

/** カンバンのカラム順（左→右）。 */
export const KANBAN_COLUMNS: readonly TaskStatus[] = [
  'proposed',
  'needs_human',
  'approved',
  'in_progress',
  'blocked',
  'done',
];

export const TASK_PRIORITIES = ['must', 'should', 'may'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  must: '必須',
  should: '推奨',
  may: '任意',
};

export const PROMOTION_TASK_CHANNELS = ['x', 'instagram', 'tiktok', 'note', 'blog'] as const;
export type PromotionTaskChannel = (typeof PROMOTION_TASK_CHANNELS)[number];

// ---------------------------------------------------------------------------
// エージェント I/O スキーマ
// ---------------------------------------------------------------------------

/** CEO が全社状況を見て決める方針＋本部別ブリーフ。 */
export const CeoPlanOutputSchema = z.object({
  title: z.string().min(1).max(120),
  period_label: z.string().min(1).max(60),
  body: z.object({
    focus_books: z.array(z.string()).max(50).default([]),
    goals: z.array(z.string()).min(1).max(20),
    kpi: z.array(z.string()).max(20).default([]),
    notes: z.string().max(2000).optional(),
  }),
  budget_jpy: z.number().int().nonnegative().nullable().optional(),
  budget_allocation: z
    .object({
      production: z.number().int().nonnegative().optional(),
      publishing: z.number().int().nonnegative().optional(),
      analytics: z.number().int().nonnegative().optional(),
      promotion: z.number().int().nonnegative().optional(),
      sysops: z.number().int().nonnegative().optional(),
      finance: z.number().int().nonnegative().optional(),
    })
    .partial()
    .nullable()
    .optional(),
  /** 各本部長への指示。本部長はこれを受けてタスクへ分解する。 */
  division_briefs: z
    .object({
      production: z.string().max(1200).optional(),
      publishing: z.string().max(1200).optional(),
      analytics: z.string().max(1200).optional(),
      promotion: z.string().max(1200).optional(),
      sysops: z.string().max(1200).optional(),
      finance: z.string().max(1200).optional(),
    })
    .partial(),
});
export type CeoPlanOutput = z.infer<typeof CeoPlanOutputSchema>;

/** 本部長が起票する 1 タスクのドラフト（LLM 出力）。 */
export const ManagerTaskDraftSchema = z.object({
  kind: z.string().min(1).max(40),
  title: z.string().min(1).max(160),
  instruction: z.string().min(1).max(4000),
  priority: z.enum(TASK_PRIORITIES).default('should'),
  /** 対象書籍 ID（プロンプトに提示された候補から選ぶ。無ければ省略）。 */
  book_id: z.string().max(40).nullable().optional(),
  channel: z.enum(PROMOTION_TASK_CHANNELS).nullable().optional(),
  account_ref: z.string().max(120).nullable().optional(),
  assignee_role: z.string().min(1).max(40),
});
export type ManagerTaskDraft = z.infer<typeof ManagerTaskDraftSchema>;

export const ManagerPlanOutputSchema = z.object({
  tasks: z.array(ManagerTaskDraftSchema).max(30).default([]),
});
export type ManagerPlanOutput = z.infer<typeof ManagerPlanOutputSchema>;

// ---------------------------------------------------------------------------
// ビューヘルパー
// ---------------------------------------------------------------------------

export function divisionLabel(division: string): string {
  return DIVISION_LABELS[division as Division] ?? division;
}

export function statusLabel(status: string): string {
  return TASK_STATUS_LABELS[status as TaskStatus] ?? status;
}

export function priorityLabel(priority: string): string {
  return PRIORITY_LABELS[priority as TaskPriority] ?? priority;
}

/** タスクが人の操作待ちか（要人手 or 提案の承認待ち）。 */
export function needsAttention(status: string): boolean {
  return status === 'needs_human' || status === 'proposed' || status === 'blocked';
}

export interface OrgTaskLike {
  status: string;
  division: string;
}

/** status → タスク配列（カンバン用）。 */
export function groupByStatus<T extends OrgTaskLike>(tasks: readonly T[]): Record<TaskStatus, T[]> {
  const out = {} as Record<TaskStatus, T[]>;
  for (const s of TASK_STATUSES) out[s] = [];
  for (const t of tasks) {
    const key = (TASK_STATUSES as readonly string[]).includes(t.status) ? (t.status as TaskStatus) : 'proposed';
    out[key].push(t);
  }
  return out;
}

/** division → タスク配列。 */
export function groupByDivision<T extends OrgTaskLike>(tasks: readonly T[]): Record<Division, T[]> {
  const out = {} as Record<Division, T[]>;
  for (const d of DIVISIONS) out[d] = [];
  for (const t of tasks) {
    if ((DIVISIONS as readonly string[]).includes(t.division)) out[t.division as Division].push(t);
  }
  return out;
}

export interface DivisionBudgetLine {
  division: Division;
  label: string;
  allocated: number | null;
  spent: number;
  /** 0..1 (allocated が無い/0 は null)。 */
  ratio: number | null;
}

/**
 * 本部別の予算配分と実コストから消化ラインを組み立てる。
 * @param allocation Objective.budget_allocation_json
 * @param spentByDivision token_usage を org_task→division で集計した実コスト(JPY)
 */
export function buildBudgetLines(
  allocation: Partial<Record<Division, number>> | null | undefined,
  spentByDivision: Partial<Record<Division, number>>,
): DivisionBudgetLine[] {
  return DIVISIONS.map((division) => {
    const allocated = allocation?.[division] ?? null;
    const spent = spentByDivision[division] ?? 0;
    const ratio = allocated && allocated > 0 ? spent / allocated : null;
    return { division, label: DIVISION_LABELS[division], allocated, spent, ratio };
  });
}
