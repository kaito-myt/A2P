/**
 * docs/05 §6.3.5 / SP-10 T-10-02 — Quality Judge エージェント I/O 契約。
 *
 * 設計判断:
 *  - JudgeInputSchema は Worker タスク (pipeline-book-judge) が Judge エージェントに
 *    渡す全コンテキストを含む。outline_summary は最大 2,000 字に制限（コスト削減）。
 *  - chapters[].body_md は各章の先頭最大 12,000 字のみを渡す（呼出側が切り出す）。
 *  - score_breakdown は 6 軸すべて 0-100 整数。各軸の平均を score_total とする
 *    （均等重み、小数点以下切り捨て — Judge 実装側で計算）。
 *  - judge_comments は軸名をキー、日本語コメントを値とした任意マップ。
 *    呼出側は score_breakdown のキーと同名を推奨するが、追加コメントも許容。
 *  - book_id の重複キーは SP-10 §T-10-02 掲載例の誤記として除去し 1 つのみ保持。
 */
import { z } from 'zod';

/**
 * Judge エージェント入力 1 章分。
 * 各章の本文は先頭 12,000 字のみ渡す（呼出側で切り出し）。
 */
export const JudgeChapterInputSchema = z.object({
  /** 1 始まりの連番。章の順序を示す。 */
  index: z.number().int().min(1),
  /** 章見出し。 */
  heading: z.string().min(1).max(200),
  /** 章本文（先頭 12,000 字）。 */
  body_md: z.string().max(12000),
});
export type JudgeChapterInput = z.infer<typeof JudgeChapterInputSchema>;

/**
 * Judge エージェント入力。
 * Worker (pipeline-book-judge) が DB から取得した情報をまとめて渡す。
 */
export const JudgeInputSchema = z.object({
  /** `Book.id` */
  book_id: z.string().min(1),
  /** graphile-worker.jobs.id — token_usage.job_id 紐付け用。 */
  job_id: z.string().optional(),
  /** ジャンル (null = ジャンル横断既定プロンプト fallback)。 */
  genre: z.enum(['practical', 'business', 'self_help']).nullable(),
  /** 採用テーマの文脈情報。 */
  theme_context: z.object({
    title: z.string().min(1).max(200),
    subtitle: z.string().max(200).optional(),
    hook: z.string().min(1).max(800),
    target_reader: z.string().min(1).max(300),
  }),
  /** アウトライン JSON の文字列化（最大 2,000 字）。 */
  outline_summary: z.string().max(2000),
  /** 採点対象の章リスト（1〜15 章）。 */
  chapters: z
    .array(JudgeChapterInputSchema)
    .min(1)
    .max(15),
});
export type JudgeInput = z.infer<typeof JudgeInputSchema>;

/**
 * Judge エージェント出力。
 * score_breakdown の 6 軸均等平均（切り捨て）が score_total となる契約
 * — Judge 実装が計算し、呼出側でも検証する。
 */
export const JudgeOutputSchema = z.object({
  /** 6 軸の均等重み平均 (0–100、切り捨て整数)。 */
  score_total: z.number().int().min(0).max(100),
  /** 6 軸の個別スコア (各 0–100)。 */
  score_breakdown: z.object({
    /** 読者へのベネフィット明確性 */
    benefit_clarity: z.number().int().min(0).max(100),
    /** 論理的一貫性 */
    logical_consistency: z.number().int().min(0).max(100),
    /** 文体の一貫性 */
    style_consistency: z.number().int().min(0).max(100),
    /** 日本語の自然さ */
    japanese_naturalness: z.number().int().min(0).max(100),
    /** タイトルとの整合性 */
    title_alignment: z.number().int().min(0).max(100),
    /** ジャンル適合度 */
    genre_fit: z.number().int().min(0).max(100),
  }),
  /**
   * 軸別 or 総評コメント（日本語）。
   * キーは score_breakdown の軸名推奨（例: "benefit_clarity"）または "overall"。
   */
  judge_comments: z.record(z.string(), z.string()),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;
