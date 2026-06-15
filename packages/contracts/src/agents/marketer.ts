/**
 * docs/05 §6.3.1 / F-001 / F-002 / F-040 — Marketer エージェント (テーマ生成 + 長期プラン + KDP メタデータ生成) の I/O 契約。
 *
 * 本ファイルにはテーマ生成 (T-03-01) / KDP メタデータ生成 (T-03-02) / 長期出版プラン (T-08-01) の型を集約する。
 *
 * 設計判断:
 *  - 型形状は docs/05 §6.3.1 既定 (title/subtitle/hook/target_reader/competitors/signals) に
 *    完全準拠する。F-001 受入基準で要求される追加情報 (reasoning/market_score/
 *    predicted_chapters/search_keywords) は `signals` 配下に集約し、DB `theme_candidates`
 *    の `signals_json` 列にそのまま保存できるようにする (Hard Rule #3 遵守 — DB スキーマ
 *    変更不要)。
 *  - title/subtitle/hook 等の長さ制約は UI 表示 (S-006/S-007) と KDP 入稿
 *    要件 (description ≤ 4000 等) を勘案して保守的に設定。
 *  - competitors は最低 1 件以上の URL を持つことが F-001 受入基準だが、Marketer 側で
 *    web_search 結果が皆無の場合に空配列を許容するため min 制約は付けず default([]) とする。
 *    空配列時の運用警告は呼出側 (worker タスク) で判定する。
 */
import { z } from 'zod';

/** F-001 受入基準: 単一書籍向けジャンル指定 + 任意のキーワード/ブリーフ。 */
export const MarketerThemeInputSchema = z.object({
  /** `theme_sessions.id` — Marketer 起動時に発行される token_usage 集計キー。 */
  themeSessionId: z.string(),
  /** `accounts.id` — 対象 KDP 出版アカウント。 */
  accountId: z.string(),
  /**
   * graphile-worker の `jobs.id` — worker 経由呼び出し時のみ設定。
   * 未指定時 (UI 直接呼び出し等) は `token_usage.job_id` は null となる
   * (FK 違反回避; theme_session_id を流用しない)。
   */
  jobId: z.string().optional(),
  /** ジャンル (null = 全ジャンル既定プロンプト fallback)。 */
  genre: z.enum(['practical', 'business', 'self_help']).nullable(),
  /** ユーザー入力 (自由テキスト)。空入力は UI 側で弾く前提。 */
  keywordOrBrief: z.string().min(1).max(500),
  /**
   * 直近 N 日の既出版/採用済タイトル — Marketer に「避けるリスト」として渡す。
   * 上限 500 件 — system prompt 肥大化防止 (呼出側でトリミング前提)。
   */
  excludeTitlesRecent: z.array(z.string()).max(500).default([]),
  /** 生成件数。F-001 既定 10、上限 30。 */
  count: z.number().int().min(1).max(30).default(10),
});
export type MarketerThemeInput = z.infer<typeof MarketerThemeInputSchema>;

/**
 * 参考競合書籍 — docs/05 §6.3.1 既定形状 (asin/title/url + rank/review_summary)。
 * F-001 受入基準: 各候補に 1 件以上の URL を持つことが望ましい (空配列許容、警告は呼出側)。
 */
export const ThemeCompetitorSchema = z.object({
  asin: z.string().optional(),
  title: z.string(),
  author: z.string().optional(),
  url: z.string().optional(),
  rank: z.number().optional(),
  review_summary: z.string().optional(),
  note: z.string().optional(),
});
export type ThemeCompetitor = z.infer<typeof ThemeCompetitorSchema>;

/**
 * テーマシグナル — docs/05 §6.3.1 既定 (search_volume/rank_estimate/sources) に加え、
 * F-001 受入基準で要求される追加情報 (reasoning/market_score/predicted_chapters/
 * search_keywords) を集約する。DB `theme_candidates.signals_json` に丸ごと保存される。
 */
export const ThemeSignalsSchema = z.object({
  /** Marketer が候補選定に至った根拠 (F-001: 想定売上シグナル)。 */
  reasoning: z.string().min(1).max(1000),
  /** 市場性スコア 0-100 (UI で並べ替えに使用)。 */
  market_score: z.number().int().min(0).max(100),
  /** 想定章数 (F-003 への申し送り、3-20)。 */
  predicted_chapters: z.number().int().min(3).max(20).default(8),
  /** Marketer が想定する検索キーワード (KDP メタデータ生成 F-040 へ流用)。 */
  search_keywords: z.array(z.string()).max(10).default([]),
  /** docs/05 既定: 概算検索ボリューム (任意)。 */
  search_volume: z.number().optional(),
  /** docs/05 既定: 競合ランク推定 (任意)。 */
  rank_estimate: z.number().optional(),
  /** docs/05 既定: web_search で参照した URL リスト (任意)。 */
  sources: z.array(z.string()).default([]),
});
export type ThemeSignals = z.infer<typeof ThemeSignalsSchema>;

/**
 * 個別テーマ候補 — `theme_candidates` 行 1 件分。
 * フィールド名は DB スキーマ (`hook`/`target_reader`/`competitors_json`/`signals_json`) と
 * 1:1 対応する (snake_case ↔ camelCase 変換は worker 側で行う)。
 */
export const ThemeCandidateSchema = z.object({
  title: z.string().min(1).max(200),
  subtitle: z.string().min(1).max(200).optional(),
  /** 差別化要素 / フック (docs/05 §6.3.1)。F-001: 「差別化要素」。 */
  hook: z.string().min(1).max(800),
  /** 想定読者 (docs/05 §6.3.1)。F-001: 「想定読者」。 */
  target_reader: z.string().min(1).max(300),
  /** 参考競合書籍リスト → DB `competitors_json`。F-001: 「参考競合 ASIN」。 */
  competitors: z.array(ThemeCompetitorSchema).default([]),
  /** Marketer 算出シグナル → DB `signals_json`。 */
  signals: ThemeSignalsSchema,
});
export type ThemeCandidate = z.infer<typeof ThemeCandidateSchema>;

/** Marketer の最終出力 — 重複除外後の candidates + 任意の総評。 */
export const MarketerThemeOutputSchema = z.object({
  candidates: z.array(ThemeCandidateSchema).min(1).max(30),
  notes: z.string().optional(),
});
export type MarketerThemeOutput = z.infer<typeof MarketerThemeOutputSchema>;

// ===========================================================================
// F-040 — KDP メタデータ生成 (T-03-02)
// ===========================================================================

/**
 * F-040 受入基準: 「完成書籍を元に紹介文/カテゴリ/キーワード/価格を生成」。
 *
 * 設計判断 (Hard Rule #3 — 設計書/DB に整合させる):
 *  - フィールドは docs/05 §6.3.1 の `MarketerMetadataOutput`
 *    (`description` / `categories(length 2)` / `keywords(max 7)` / `suggested_price_jpy`)
 *    と DB `kdp_metadata` 列 (`description` / `categories String[]` / `keywords String[]` /
 *    `price_jpy Int`) に **完全整合** させる。
 *  - 追加フィールド (title/subtitle/language/reading_age 等) は現時点で docs/05 にも DB にも
 *    存在しないため本 schema には含めない (タイトル/副題は `Book` 行から取得し worker 側で
 *    KDP に流す)。将来 KDP の追加項目を扱う場合は docs/05 と schema.prisma を先に更新する。
 *  - 入力は worker 経由 (T-03-04 pipeline.book.marketer) で `bookId` 指定が原則だが、
 *    UI 直接呼び出しでも動作するよう `bookId` も optional に倒し、Marketer に渡す
 *    `themeContext` (採用 theme から派生) は呼出側で構築して渡す。
 *  - `jobId` は graphile-worker.jobs.id 専用 (FK 制約)。未指定時は token_usage.job_id が
 *    null になる (T-03-01 教訓: theme_session_id を流用しない)。
 */
export const MarketerMetadataInputSchema = z.object({
  /** Marketer 起動時の token_usage 集計キー。書籍未確定段階 (theme→metadata プレビュー) 用。 */
  themeSessionId: z.string().optional(),
  /** graphile-worker.jobs.id — worker 経由呼び出し時のみ設定 (FK 違反回避)。 */
  jobId: z.string().optional(),
  /** `Book.id` — 確定書籍に対するメタデータ生成時に指定 (token_usage.book_id 紐付け)。 */
  bookId: z.string().optional(),
  /** `accounts.id` — F-040 受入基準: 出版アカウントごとの想定読者を考慮。 */
  accountId: z.string(),
  /** ジャンル (null = 全ジャンル既定プロンプト fallback)。 */
  genre: z.enum(['practical', 'business', 'self_help']).nullable(),
  /**
   * 採用テーマから派生する文脈 — Marketer に渡す。
   * NOTE: signals は ThemeSignalsSchema 全部までは要求せず `z.unknown()` で受ける
   *       (呼出側で適宜整形できる柔軟性確保)。competitors も同様。
   */
  themeContext: z.object({
    title: z.string().min(1).max(200),
    subtitle: z.string().min(1).max(200).optional(),
    hook: z.string().min(1).max(800),
    target_reader: z.string().min(1).max(300),
    competitors: z.array(z.unknown()).max(50).default([]),
    signals: z.unknown().optional(),
  }),
});
export type MarketerMetadataInput = z.infer<typeof MarketerMetadataInputSchema>;

/**
 * KDP メタデータ 1 件分 — DB `kdp_metadata` 行と 1:1 対応。
 *
 * KDP 制約 (F-040 受入基準 + Amazon KDP ヘルプ):
 *  - description: HTML タグ込みで 4000 文字以内 (本実装ではプレーンテキストのみ)
 *  - keywords: 最大 7 個 (各 50 文字以内、空文字禁止)
 *  - categories: 2 個固定 (KDP は最大 3 だが docs/05 §6.3.1 で 2 と確定)
 *  - price_jpy: KDP 最低価格 99 円 (docs/05 §6.3.1: `suggested_price_jpy.min(99)`)
 */
export const KdpMetadataSchema = z.object({
  description: z.string().min(50).max(4000),
  categories: z.array(z.string().min(1).max(200)).length(2),
  keywords: z.array(z.string().min(1).max(50)).min(1).max(7),
  /** DB 列名は `price_jpy` だが docs/05 §6.3.1 の Marketer 出力としては suggested_price_jpy。 */
  suggested_price_jpy: z.number().int().min(99).max(99999),
});
export type KdpMetadata = z.infer<typeof KdpMetadataSchema>;

/** Marketer の KDP メタデータ最終出力 — 1 件 (book と 1:1) + 任意の総評。 */
export const MarketerMetadataOutputSchema = z.object({
  metadata: KdpMetadataSchema,
  notes: z.string().optional(),
});
export type MarketerMetadataOutput = z.infer<typeof MarketerMetadataOutputSchema>;

// ===========================================================================
// F-002 — 長期出版プラン生成 (T-08-01)
// ===========================================================================

/**
 * F-002 受入基準: アカウント既出版実績 + 売上トレンドを元に月単位の出版プランを提案。
 *
 * 設計判断:
 *  - `published_books` / `sales_trend` は worker/SA 側が DB から取得して渡す。
 *    エージェント層はデータアクセスせず、渡されたコンテキストをプロンプトに注入する
 *    (他の Marketer エージェントと同じ注入パターン)。
 *  - `jobId` は graphile-worker.jobs.id 専用 (FK 違反回避)。SA 内同期呼び出し
 *    (F-002 は SA 内同期) のため通常 undefined になる。
 */
export const MarketerPlanInputSchema = z.object({
  /** `accounts.id` — 対象 KDP 出版アカウント。 */
  accountId: z.string(),
  /** 計画期間 (月数)。1〜12。 */
  months: z.number().int().min(1).max(12),
  /** 期間内の目標出版冊数。 */
  target_count: z.number().int().min(1).max(500),
  /**
   * 既出版実績 — `Book` × `SalesRecord` の集計。
   * エージェントは「何が売れているか」を踏まえて続編 / ジャンル配分を提案する。
   */
  published_books: z.array(
    z.object({
      title: z.string(),
      genre: z.string(),
      /** 最新月のロイヤリティ合計 (円)。売上 0 の場合 0。 */
      recent_royalty_jpy: z.number().int().min(0),
      /** 累計レビュー数。 */
      review_count: z.number().int().min(0),
      /** 平均星評価 (null = データなし)。 */
      avg_stars: z.number().min(0).max(5).nullable(),
    }),
  ).default([]),
  /**
   * 月次売上トレンド — 直近 N ヶ月の `SalesRecord` 集計 (month 降順)。
   * エージェントが季節性・成長率を判断するために使う。
   */
  sales_trend: z.array(
    z.object({
      /** "2026-05" 形式。 */
      ym: z.string(),
      /** その月の全書籍合計ロイヤリティ (円)。 */
      total_royalty_jpy: z.number().int().min(0),
    }),
  ).default([]),
  /** graphile-worker.jobs.id — worker 経由呼び出し時のみ設定 (FK 違反回避)。 */
  jobId: z.string().optional(),
});
export type MarketerPlanInput = z.infer<typeof MarketerPlanInputSchema>;

/**
 * 月単位の出版計画 — `PublishingPlan.plan_json` の `months` 配列の 1 要素。
 * DB スキーマ (docs/05 §3 PublishingPlan.plan_json) と 1:1 対応する。
 */
export const PlanMonthSchema = z.object({
  /** "2026-05" 形式の年月。 */
  ym: z.string().regex(/^\d{4}-\d{2}$/),
  /** その月に出版予定の冊数。 */
  planned_count: z.number().int().min(0),
  /** その月に重点的に扱うテーマカテゴリ (例: "副業", "ChatGPT 活用")。 */
  theme_categories: z.array(z.string().min(1)).min(1),
  /**
   * その月の続編候補シリーズ名 (例: "副業で月 5 万円 Vol.2")。
   * 既存シリーズなし or 続編不要の場合は空配列。
   */
  series_candidates: z.array(z.string()).default([]),
});
export type PlanMonth = z.infer<typeof PlanMonthSchema>;

/** Marketer の長期出版プラン最終出力 — `PublishingPlan.plan_json` に丸ごと保存される。 */
export const MarketerPlanOutputSchema = z.object({
  months: z.array(PlanMonthSchema).min(1),
  notes: z.string().optional(),
});
export type MarketerPlanOutput = z.infer<typeof MarketerPlanOutputSchema>;
