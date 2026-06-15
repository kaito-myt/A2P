/**
 * docs/05 §6.3.7 / SP-11 T-11-01 — Prompt Optimizer エージェント I/O 契約。
 *
 * Optimizer は特定の書籍に紐づかないシステムタスク。
 * token_usage.book_id = null で記録される。
 */
import { z } from 'zod';

export const OptimizerInputSchema = z.object({
  /** 最適化対象のエージェント役割 (例: 'writer', 'editor')。 */
  role: z.string(),
  /** ジャンル絞り込み (null = ジャンル横断既定プロンプト対象)。 */
  genre: z.string().nullable(),
  /** graphile-worker の Job.id — token_usage.job_id 紐付け用。 */
  job_id: z.string().optional(),
  /** 直近の評価結果サマリ (直近 10 冊分)。 */
  recent_evals: z.array(
    z.object({
      book_id: z.string(),
      score_total: z.number(),
      score_breakdown: z.record(z.string(), z.number()),
      prompt_version_id: z.string(),
    }),
  ),
  /** 直近の販売実績サマリ。 */
  recent_sales: z.array(
    z.object({
      book_id: z.string(),
      royalty_jpy: z.number(),
      avg_stars: z.number().nullable(),
    }),
  ),
  /** 現在の active プロンプト情報。 */
  current_prompt: z.object({
    id: z.string(),
    body: z.string(),
    version: z.number(),
  }),
});
export type OptimizerInput = z.infer<typeof OptimizerInputSchema>;

export const OptimizerOutputSchema = z.object({
  /** 改訂後のプロンプト本文。 */
  proposed_body: z.string().min(1),
  /** unified diff 形式の変更差分。 */
  diff: z.string(),
  /** 改訂理由（日本語）。 */
  rationale: z.string(),
  /** 改訂による期待効果。 */
  expected_effect: z.object({
    /** スコア改善の見込み (delta)。 */
    score_delta: z.number().optional(),
    /** 売上改善の見込み (%)。 */
    sales_delta_pct: z.number().optional(),
  }),
  /** 改訂後プロンプトを使った場合の出力例（任意）。 */
  sample_output: z.string().optional(),
});
export type OptimizerOutput = z.infer<typeof OptimizerOutputSchema>;
