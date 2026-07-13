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
  account_strategist: 'アカウント戦略担当',
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
  promotion: ['plan_accounts', 'create_content', 'publish_post', 'analyze_promo', 'create_account', 'connect_account'],
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
  plan_accounts: 'アカウント戦略',
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

/**
 * 実行に人手を要する種別 → 起票時 status='needs_human'。
 * - create_account/connect_account/publish_kdp: 外部公開・KYC（P1）。
 * - enforce_limit/triage_error: 予算超過の凍結/再配分・原因不明ジョブ障害の判断（P3）— CEO/CFO/運営者が決める。
 */
export const HUMAN_KINDS = new Set<string>([
  'create_account',
  'connect_account',
  'publish_kdp',
  'enforce_limit',
  'triage_error',
]);

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
  /** 制作 write タスク: 起票元テーマ候補 ID（あれば dispatcher が kickoff で使う）。 */
  theme_id: z.string().max(40).nullable().optional(),
  /** 制作タスクの発注 KDP アカウント（省略時は dispatcher が既定アカウントを解決）。 */
  account_id: z.string().max(40).nullable().optional(),
});
export type ManagerTaskDraft = z.infer<typeof ManagerTaskDraftSchema>;

export const ManagerPlanOutputSchema = z.object({
  tasks: z.array(ManagerTaskDraftSchema).max(30).default([]),
});
export type ManagerPlanOutput = z.infer<typeof ManagerPlanOutputSchema>;

// ---------------------------------------------------------------------------
// 担当者エージェント I/O スキーマ (P2 — 実行レイヤー)
// ---------------------------------------------------------------------------

/** 本部横断の改善示唆（分析→CEO/制作/販促へ還元する1件）。 */
export const AnalysisSuggestionSchema = z.object({
  division: z.enum(DIVISIONS),
  action: z.string().min(1).max(200),
  rationale: z.string().max(600).default(''),
});
export type AnalysisSuggestion = z.infer<typeof AnalysisSuggestionSchema>;

/** 売上アナリスト (sales_analyst) の出力。 */
export const SalesAnalysisOutputSchema = z.object({
  summary: z.string().min(1).max(2000),
  trends: z.array(z.string().max(300)).max(12).default([]),
  top_books: z.array(z.string().max(200)).max(10).default([]),
  underperformers: z.array(z.string().max(200)).max(10).default([]),
  suggestions: z.array(AnalysisSuggestionSchema).max(6).default([]),
});
export type SalesAnalysisOutput = z.infer<typeof SalesAnalysisOutputSchema>;

/** 市場アナリスト (market_analyst) の出力。 */
export const MarketResearchOutputSchema = z.object({
  summary: z.string().min(1).max(2000),
  genre_opportunities: z
    .array(z.object({ genre: z.string().max(80), why: z.string().max(400).default('') }))
    .max(10)
    .default([]),
  theme_ideas: z
    .array(z.object({ title: z.string().max(160), angle: z.string().max(400).default('') }))
    .max(12)
    .default([]),
  suggestions: z.array(AnalysisSuggestionSchema).max(6).default([]),
});
export type MarketResearchOutput = z.infer<typeof MarketResearchOutputSchema>;

/** 入稿担当 (metadata_worker) の出力 — KDP メタデータ草案。 */
export const MetadataDraftOutputSchema = z.object({
  title: z.string().min(1).max(200),
  subtitle: z.string().max(200).nullable().optional(),
  description: z.string().min(1).max(4000),
  keywords: z.array(z.string().max(60)).max(7).default([]),
  categories: z.array(z.string().max(120)).max(3).default([]),
  price_jpy: z.number().int().positive().max(2000).nullable().optional(),
  rationale: z.string().max(1200).default(''),
});
export type MetadataDraftOutput = z.infer<typeof MetadataDraftOutputSchema>;

/** 販促アナリスト (promo_analyst) の出力 — 投稿実績×売上の効果検証。 */
export const PromoAnalysisOutputSchema = z.object({
  summary: z.string().min(1).max(2000),
  highlights: z.array(z.string().max(300)).max(12).default([]),
  underperformers: z.array(z.string().max(300)).max(10).default([]),
  suggestions: z.array(AnalysisSuggestionSchema).max(6).default([]),
});
export type PromoAnalysisOutput = z.infer<typeof PromoAnalysisOutputSchema>;

/** コスト会計 (cost_accountant) の出力 — 本部別コスト×書籍別ROIの講評＋是正示唆。 */
export const CostReportOutputSchema = z.object({
  summary: z.string().min(1).max(2000),
  findings: z.array(z.string().max(300)).max(12).default([]),
  /** 赤字/低ROI書籍のタイトル（人が読む形）。 */
  loss_making: z.array(z.string().max(200)).max(10).default([]),
  suggestions: z.array(AnalysisSuggestionSchema).max(6).default([]),
});
export type CostReportOutput = z.infer<typeof CostReportOutputSchema>;

/** アカウント戦略担当 (account_strategist) の出力 — 多アカウント運用の戦略。 */
export const AccountStrategyOutputSchema = z.object({
  summary: z.string().min(1).max(2000),
  /** 新規に用意すべきニッチ専用アカウント（作成仕様まで含む。作成は人手ゲート）。 */
  recommended_accounts: z
    .array(
      z.object({
        channel: z.enum(PROMOTION_TASK_CHANNELS),
        niche: z.string().min(1).max(120),
        target_reader: z.string().max(200).default(''),
        /** 推奨ハンドル案（@なし・英数字）。 */
        handle_suggestion: z.string().max(60).default(''),
        bio: z.string().max(600).default(''),
        posting_policy: z.string().max(600).default(''),
        rationale: z.string().max(600).default(''),
      }),
    )
    .max(8)
    .default([]),
  /** 既存の接続済みアカウント/チャンネルの活用方針。 */
  routing: z
    .array(z.object({ target: z.string().max(120), use_for: z.string().max(400).default('') }))
    .max(12)
    .default([]),
  suggestions: z.array(AnalysisSuggestionSchema).max(6).default([]),
});
export type AccountStrategyOutput = z.infer<typeof AccountStrategyOutputSchema>;

// ---------------------------------------------------------------------------
// ディスパッチ (org.execute.dispatch) の語彙
// ---------------------------------------------------------------------------

/**
 * P2 で dispatcher が自動実行できる kind。
 * - 制作の write/edit/design_cover/qa は自走パイプライン（4つの人手ゲート）が処理するため、
 *   ここでは plan_book（テーマ生成）と write（本の制作起動）のみを扱う。
 * - publish_kdp / create_account 等の人手 kind は needs_human のまま（含めない）。
 */
export const DISPATCHABLE_KINDS = new Set<string>([
  // production
  'plan_book',
  'write',
  // publishing
  'prepare_metadata',
  'set_price',
  // analytics
  'analyze_sales',
  'research_market',
  'report',
  // promotion (P3) — v1 販促エンジンへ接続。create_account/connect_account は human。
  'create_content',
  'publish_post',
  'analyze_promo',
  // promotion (P4) — アカウント戦略の自律立案（新規作成そのものは needs_human で起票）。
  'plan_accounts',
  // sysops (P3) — 自己復旧。triage_error は needs_human、monitor は cron(org.ops.watch)が担う。
  'recover_job',
  // finance (P3) — 本部別コスト/ROI集計。enforce_limit は needs_human、cron(org.finance.tick)が予算ガード。
  'cost_report',
  'budget_review',
]);

export function isDispatchableKind(kind: string): boolean {
  return DISPATCHABLE_KINDS.has(kind);
}

/** 改善ToDoを起票する際、本部→既定 kind / 既定担当ロール。 */
export const DIVISION_DEFAULT_KIND: Record<Division, string> = {
  production: 'plan_book',
  publishing: 'prepare_metadata',
  analytics: 'research_market',
  promotion: 'create_content',
  sysops: 'monitor',
  finance: 'cost_report',
};

export const DIVISION_DEFAULT_ASSIGNEE: Record<Division, string> = {
  production: 'marketer',
  publishing: 'metadata_worker',
  analytics: 'market_analyst',
  promotion: 'content_creator',
  sysops: 'ops_worker',
  finance: 'cost_accountant',
};

/** priority を数値ランクに（must=0 が最優先）。 */
export function priorityRank(priority: string): number {
  const idx = (TASK_PRIORITIES as readonly string[]).indexOf(priority);
  return idx < 0 ? TASK_PRIORITIES.length : idx;
}

// ---------------------------------------------------------------------------
// 勝ちパターン学習 (P4 増分4) — 売上実績から「効いている型」を決定的に抽出し CEO へ供給
// ---------------------------------------------------------------------------

export interface BookPerf {
  genre: string | null;
  royalty_jpy: number;
  published: boolean;
}

export interface WinningPatterns {
  /** 稼ぐジャンル順（royalty 降順、売上>0 のみ）。 */
  top_genres: Array<{ genre: string; royalty_jpy: number; book_count: number }>;
  /** 在庫はあるが売上0のジャンル（露出/販促の余地）。 */
  underexposed_genres: Array<{ genre: string; book_count: number }>;
  /** 人が読む短い学習知見（CEO/本部長のプロンプトに供給）。 */
  insights: string[];
}

/**
 * 書籍別の実績から「勝ちパターン」を抽出する（決定的・LLM 非依存）。
 * どのジャンルが稼ぎ、どのジャンルが在庫過多で売れていないかを可視化し、
 * CEO の次サイクルの企画/予算配分の判断材料にする（docs §13 意思決定の質）。
 */
export function computeWinningPatterns(books: readonly BookPerf[]): WinningPatterns {
  const royaltyByGenre = new Map<string, number>();
  const countByGenre = new Map<string, number>();
  for (const b of books) {
    const g = b.genre ?? '未分類';
    countByGenre.set(g, (countByGenre.get(g) ?? 0) + 1);
    royaltyByGenre.set(g, (royaltyByGenre.get(g) ?? 0) + (Number.isFinite(b.royalty_jpy) ? b.royalty_jpy : 0));
  }

  const top_genres = [...royaltyByGenre.entries()]
    .filter(([, r]) => r > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([genre, royalty_jpy]) => ({ genre, royalty_jpy, book_count: countByGenre.get(genre) ?? 0 }));

  const underexposed_genres = [...countByGenre.entries()]
    .filter(([g, c]) => (royaltyByGenre.get(g) ?? 0) === 0 && c > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([genre, book_count]) => ({ genre, book_count }));

  const insights: string[] = [];
  const totalRoyalty = [...royaltyByGenre.values()].reduce((a, b) => a + b, 0);
  if (top_genres.length > 0) {
    const t = top_genres[0]!;
    insights.push(`「${t.genre}」が最も稼ぐジャンル（¥${t.royalty_jpy.toLocaleString('ja-JP')} / ${t.book_count}冊）。次サイクルはこの型を厚くする。`);
    if (top_genres.length > 1) {
      const w = top_genres[top_genres.length - 1]!;
      insights.push(`稼ぎの薄いジャンル「${w.genre}」は制作を絞るか切り口を変える。`);
    }
  }
  for (const u of underexposed_genres.slice(0, 2)) {
    insights.push(`「${u.genre}」は${u.book_count}冊あるが売上0 — 制作より露出/販促を優先。`);
  }
  if (totalRoyalty === 0) {
    insights.push('売上実績がまだ乏しい — まず在庫と初期露出（販促）を増やし、勝ち筋のデータを貯める。');
  }

  return { top_genres, underexposed_genres, insights };
}

// ---------------------------------------------------------------------------
// KDP 公開可否ガードレール (P4 増分3) — 誤公開防止の決定的スクリーニング
// ---------------------------------------------------------------------------

export interface KdpReadinessInput {
  /** Book.status（'done' 以外は不可）。 */
  book_status: string;
  /** Book.publish_status（'published' は既に公開済みで不可）。 */
  publish_status: string;
  /** must コメント（未解決なら不可）。 */
  has_blocking_comments: boolean;
  /** 直近の EvalResult.score_total（0..100, null=未採点）。 */
  quality_score: number | null;
  /** KdpMetadata。null=未整備。 */
  metadata: { price_jpy: number | null; description_len: number; keywords_count: number } | null;
}

export interface KdpReadinessThresholds {
  min_quality: number;
  min_price_jpy: number;
  max_price_jpy: number;
}

export interface KdpReadinessResult {
  eligible: boolean;
  /** 未達チェックの理由（eligible=true のとき空）。 */
  reasons: string[];
}

/**
 * 書籍が KDP 自動公開の安全条件を満たすか判定する（決定的・LLM 非依存）。
 * すべての条件を満たしたときだけ eligible=true。1 つでも欠ければ理由を列挙して不可。
 * 「誤公開の実害が大きい」ため、判定は保守的（不確実なら不可）。
 */
export function evaluateKdpPublishReadiness(
  input: KdpReadinessInput,
  thresholds: KdpReadinessThresholds,
): KdpReadinessResult {
  const reasons: string[] = [];
  if (input.book_status !== 'done') reasons.push(`本の生成が未完了（status=${input.book_status}）`);
  if (input.publish_status === 'published') reasons.push('すでに公開済み');
  if (input.has_blocking_comments) reasons.push('未解決の must コメントあり');
  if (input.quality_score == null) reasons.push('品質未採点');
  else if (input.quality_score < thresholds.min_quality)
    reasons.push(`品質スコアが基準未満（${input.quality_score} < ${thresholds.min_quality}）`);
  if (!input.metadata) {
    reasons.push('KDPメタデータ未整備');
  } else {
    const { price_jpy, description_len, keywords_count } = input.metadata;
    if (price_jpy == null) reasons.push('価格未設定');
    else if (price_jpy < thresholds.min_price_jpy || price_jpy > thresholds.max_price_jpy)
      reasons.push(`価格が許容帯外（¥${price_jpy}／許容 ¥${thresholds.min_price_jpy}〜¥${thresholds.max_price_jpy}）`);
    if (description_len <= 0) reasons.push('紹介文が空');
    if (keywords_count <= 0) reasons.push('キーワード未設定');
  }
  return { eligible: reasons.length === 0, reasons };
}

export interface DependentLike {
  depends_on?: readonly string[] | null;
}

/** タスクの依存が全て done か（done タスク ID 集合を渡す）。 */
export function depsSatisfied(task: DependentLike, doneIds: ReadonlySet<string>): boolean {
  const deps = task.depends_on ?? [];
  for (const id of deps) {
    if (!doneIds.has(id)) return false;
  }
  return true;
}

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

export interface BudgetBreach {
  scope: 'total' | Division;
  label: string;
  allocated: number;
  spent: number;
  ratio: number;
}

/**
 * 予算ガード (docs/06 §9) — 全社/本部別で消化率が閾値を超えた項目を返す。
 * finance.tick が超過項目について enforce_limit(needs_human) を起票する根拠。
 *
 * @param threshold 0..1（既定 1.0 = 100%）。0.9 なら 90% 到達で検知。
 */
export function detectBudgetBreaches(
  totalBudget: number | null | undefined,
  totalSpent: number,
  allocation: Partial<Record<Division, number>> | null | undefined,
  spentByDivision: Partial<Record<Division, number>>,
  threshold = 1.0,
): BudgetBreach[] {
  const out: BudgetBreach[] = [];
  if (totalBudget && totalBudget > 0 && totalSpent >= totalBudget * threshold) {
    out.push({ scope: 'total', label: '全社', allocated: totalBudget, spent: totalSpent, ratio: totalSpent / totalBudget });
  }
  for (const division of DIVISIONS) {
    const allocated = allocation?.[division];
    if (!allocated || allocated <= 0) continue;
    const spent = spentByDivision[division] ?? 0;
    if (spent >= allocated * threshold) {
      out.push({ scope: division, label: DIVISION_LABELS[division], allocated, spent, ratio: spent / allocated });
    }
  }
  return out;
}
