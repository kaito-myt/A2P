/**
 * docs/05 §6.3.2 / F-003 / F-004 — Writer エージェント (アウトライン生成 + 章執筆) の I/O 契約。
 *
 * 本ファイルにはアウトライン生成 (T-04-01) と章執筆 (T-04-02) の型を定義する。
 *
 * 設計判断 (Hard Rule #3 — DB / docs/05 §6.3.2 整合):
 *  - 型形状は docs/05 §6.3.2 既定 (chapters[].index/heading/summary/target_chars/subheadings) に
 *    完全準拠する。後段 T-04-02 (writer chapter 入力)、T-04-04 (worker outline INSERT)、
 *    T-04-07/T-04-08 (bulk approve / S-011 UI 編集 SA) で同フィールド名を参照する前提。
 *  - 出力 chapters は `Outline.chapters_json` (Json 列) にそのまま保存される想定で、
 *    Outline INSERT は worker タスク (T-04-04) 側で行う。
 *  - 入力 `themeContext` は採用テーマ (`ThemeCandidate`) から派生する文脈で、
 *    Marketer 出力との重複保持を避けつつ Writer が必要とする最小集合に絞る。
 *  - `kdpMetadata` は任意で、Marketer メタデータが先行決定済みなら章設計の参考として渡せる。
 *  - `rejectNote` は F-018 差戻し時の運営者コメントで、Writer 再実行プロンプトに注入する。
 *
 * 文字数バリデーション (T-04-01 完了判定):
 *  - 章数 7〜10
 *  - 各章 `target_chars` の合計が **45,000〜55,000 字 ±15% の許容範囲** (= 38,250〜63,250)
 *  - 範囲外は呼出側 (generateOutline) で `AgentError('writer.outline.chars_out_of_range')`
 *  - 本 zod schema 自体には合計値制約は載せず、呼出側で計算後に強制する
 *    (zod superRefine だと details (total/min/max) を AgentError に渡しにくいため)
 */
import { z } from 'zod';

/** Writer アウトライン LLM 呼出入力。F-003 受入基準を満たすため、テーマ + 想定文字数を最低限渡す。 */
export const WriterOutlineInputSchema = z.object({
  /** graphile-worker.jobs.id — worker 経由呼び出し時のみ設定 (FK 違反回避、T-03-01 教訓)。 */
  jobId: z.string().optional(),
  /** `Book.id` — token_usage.book_id 紐付け先。Writer 起動時点で book は確定済み。 */
  bookId: z.string(),
  /** `accounts.id` — F-001 と同様、出版アカウントごとの想定読者を考慮するため受け取る。 */
  accountId: z.string(),
  /** ジャンル (null = 全ジャンル既定プロンプト fallback)。 */
  genre: z.enum(['practical', 'business', 'self_help']).nullable(),
  /** 採用テーマから派生する文脈 — Writer に渡す最小集合。 */
  themeContext: z.object({
    title: z.string().min(1).max(200),
    subtitle: z.string().min(1).max(200).optional(),
    hook: z.string().min(1).max(800),
    target_reader: z.string().min(1).max(300),
  }),
  /** Marketer 先行生成済みの KDP メタデータ (任意)。章設計の参考に使える。 */
  kdpMetadata: z
    .object({
      description: z.string(),
      keywords: z.array(z.string()),
    })
    .optional(),
  /** F-018 差戻し時の運営者コメント。Writer 再実行プロンプトに注入する。 */
  rejectNote: z.string().max(2000).optional(),
  /** 想定章数 (既定 8、F-003 既定 7〜10)。 */
  targetChapterCount: z.number().int().min(7).max(10).default(8),
  /** 想定総文字数 (既定 50,000、§13 設計判断 #1 既定 45,000〜55,000)。 */
  targetTotalChars: z.number().int().min(30000).max(80000).default(50000),
});
export type WriterOutlineInput = z.infer<typeof WriterOutlineInputSchema>;

/**
 * 個別章のアウトライン — `Outline.chapters_json[]` に保存される 1 要素分。
 *
 * フィールド名は docs/05 §6.3.2 (index/heading/summary/target_chars/subheadings) に完全準拠。
 * 後段 T-04-02 (writer chapter 入力)、T-04-04 (worker outline INSERT)、
 * T-04-07/T-04-08 (bulk approve / S-011 UI 編集 SA) で同フィールド名を参照する。
 */
export const ChapterPlanSchema = z.object({
  /** 1 始まりの連番。Writer.chapter (T-04-02) で `Chapter.index` に直接マップ。 */
  index: z.number().int().min(1),
  /** 章見出し (`Chapter.heading` に対応)。 */
  heading: z.string().min(1).max(200),
  /** 章要旨 (1〜800 字、過去章サマリの種にもなる)。 */
  summary: z.string().min(1).max(800),
  /** 章の想定文字数。F-004 で ±20% 範囲チェックに使われる。 */
  target_chars: z.number().int().min(2000).max(15000),
  /** 章で扱う主要トピック / 小見出し (2〜10、§6.3.2 の subheadings 最小 2 制約と整合)。 */
  subheadings: z.array(z.string().min(1).max(200)).min(2).max(10),
});
export type ChapterPlan = z.infer<typeof ChapterPlanSchema>;

/**
 * Writer アウトラインの最終出力。
 *
 * - chapters: 7〜10 章 (zod 強制)
 * - totalCharsEstimate: 章ごと target_chars の合計値 (LLM 側で算出するが、generateOutline で
 *   再計算し検証する。LLM 値を信用しすぎないための安全弁)
 * - notes: 任意の総評 (運営者向けメモ)
 */
export const WriterOutlineOutputSchema = z.object({
  chapters: z.array(ChapterPlanSchema).min(7).max(10),
  totalCharsEstimate: z.number().int(),
  notes: z.string().optional(),
});
export type WriterOutlineOutput = z.infer<typeof WriterOutlineOutputSchema>;

// ===========================================================================
// T-04-02: 章執筆 (Writer chapter) の I/O 契約
// ===========================================================================

/**
 * Writer chapter LLM 呼出入力。
 *
 * 設計判断 (Hard Rule #3 — docs/05 §6.3.2 既定 schema 準拠):
 *  - docs/05 既定の `WriterChapterInput` は `{ book_id, chapter_index, outline_chapter,
 *    previous_summary?, style_guide, feedback?: Array<{body, priority}> }` 形式。
 *    本 schema は docs/05 既定をベースに、T-04-01 outline I/F (jobId / bookId / accountId /
 *    genre / themeContext) との一貫性を加える拡張版。
 *  - `feedback` は docs/05 既定の構造化形式 (`Array<{body, priority}>`) を採用。F-050
 *    Revision Applier (docs/05 §6.3.6) が同形式で `revision.book.apply` から渡す。
 *    タスク指示 (T-04-02) の `z.string().max(2000)` は採用しない — priority 不在では
 *    must コメントの強制反映 (F-049) が SA 層で実現不可能になるため。
 *  - `previousChaptersSummary` は文体一貫性 (docs/05 §5.3.4 `previous_summary`) のため。
 *    SP-04 では `pipeline.book.writer.chapter` タスク側が直前章 `body_md` の先頭 200 字を
 *    詰める簡易実装（タスク詳細 T-04-05）。Writer 自身は受け取って prompt に注入するだけ。
 *  - `outlineChapter` は採用 outline (Outline.chapters_json[index]) の 1 要素。
 *    `ChapterPlanSchema` を流用することで T-04-04 (outline INSERT) → T-04-05 (chapter
 *    入力) のデータ受け渡しがロスレスになる。
 *  - `themeContext` は outline と同じ最小集合 (title/subtitle/hook/target_reader)。
 *    Writer に書籍全体の方向性を再注入し、章間ズレを抑える。
 *
 * 受入基準 (F-004 / docs/02 L203):
 *  - 章本文 1 章 = outlineChapter.target_chars の ±20% 範囲内 (呼出側 generateChapter で強制)
 *  - feedback を受け取り、prompt に反映できる
 *  - token_usage.book_id 紐付け (jobId は graphile-worker.jobs.id 専用、未指定で null)
 */
export const RevisionFeedbackItemSchema = z.object({
  body: z.string().min(1).max(2000),
  priority: z.enum(['must', 'should', 'may']),
});
export type RevisionFeedbackItem = z.infer<typeof RevisionFeedbackItemSchema>;

export const WriterChapterInputSchema = z.object({
  /** graphile-worker.jobs.id — worker 経由呼出時のみ。T-03-01 教訓: 未指定で token_usage.job_id=null forward。 */
  jobId: z.string().optional(),
  /** `Book.id` — token_usage.book_id 紐付け先。 */
  bookId: z.string(),
  /** `accounts.id` — outline と同じく文脈として保持。 */
  accountId: z.string(),
  /** ジャンル (null = 全ジャンル既定プロンプト fallback)。 */
  genre: z.enum(['practical', 'business', 'self_help']).nullable(),
  /** 採用 outline の章 1 要素 (ChapterPlanSchema)。`Chapter.index` / `Chapter.heading` のソース。 */
  outlineChapter: ChapterPlanSchema,
  /** 書籍全体の方向性 — outline と同じ最小集合。 */
  themeContext: z.object({
    title: z.string().min(1).max(200),
    subtitle: z.string().min(1).max(200).optional(),
    hook: z.string().min(1).max(800),
    target_reader: z.string().min(1).max(300),
  }),
  /** 直前章までの要約 (文体一貫性用、SP-04 では先頭 200 字でも可)。 */
  previousChaptersSummary: z.string().max(4000).optional(),
  /** F-050 修正コメント反映 — docs/05 既定の構造化形式 (priority 別)。 */
  feedback: z.array(RevisionFeedbackItemSchema).max(50).optional(),
});
export type WriterChapterInput = z.infer<typeof WriterChapterInputSchema>;

/**
 * Writer chapter の最終出力。
 *
 * 設計判断 (Hard Rule #3 — docs/05 §6.3.2 既定 schema 準拠):
 *  - docs/05 既定は `{ heading: string, body_md: string, char_count: int }`。
 *    本 schema は docs/05 既定を完全踏襲する。タスク指示の `warnings` は不採用
 *    (SP-04 全体で他箇所の参照なし、警告は Editor `diff_summary` が担う設計)。
 *  - `heading` は outlineChapter.heading の echo が基本だが、Writer が章タイトルを
 *    微調整する余地を残す (Chapter.heading に直接保存)。
 *  - `body_md` の min(500) は generateChapter の文字数検証 (±20%) の手前の防衛線。
 *    target_chars の下限 2000 × 0.80 = 1600 字が実質下限だが、明らかに本文として
 *    不十分なケース (空応答に近い JSON) を zod 層で早期に弾くため 500 字を設定。
 *  - `char_count` は LLM 申告値だが、generateChapter 側で `[...body_md].length` で
 *    再計算し output に上書きする (信頼境界の整理、outline と同パターン)。
 */
export const WriterChapterOutputSchema = z.object({
  heading: z.string().min(1).max(200),
  body_md: z.string().min(500),
  char_count: z.number().int().min(500),
});
export type WriterChapterOutput = z.infer<typeof WriterChapterOutputSchema>;
