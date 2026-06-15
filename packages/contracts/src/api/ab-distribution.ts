/**
 * A/B 配信 API 契約 (T-11-06)
 *
 * startAbDistribution Server Action の入力スキーマ。
 * 設計根拠: docs/05 §4.3.11, F-031
 */
import { z } from 'zod';

export const StartAbDistributionInputSchema = z.object({
  role: z.string().min(1),
  genre: z.string().min(1),
  baseline_id: z.string().min(1),
  candidate_id: z.string().min(1),
  ratio_candidate: z.number().min(0).max(1),
});

export type StartAbDistributionInput = z.infer<typeof StartAbDistributionInputSchema>;
