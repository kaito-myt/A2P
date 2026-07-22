/**
 * F-062 — 週次コスト改善提案担当 (cost_optimizer) の I/O 契約。
 *
 * 直近のコスト内訳（役割×モデル別のトークン/画像コスト）・現行のモデル割当・
 * 単価カタログ・運用設定を受け取り、コスト改善案とその影響、そして「安全に自動実行できる
 * アクション」を構造化して返す。ユーザーが承認したら executor が実行する。
 *
 * 実行できるアクション（安全・可逆のみ）:
 *  - switch_model_assignment: ある役割のモデルをより安価なものへ切替（可逆）。
 *  - set_app_setting: 許可リストの運用設定（投稿頻度 cron / 見直しの ON-OFF 等）を変更。
 *  - advisory: 自動実行しない助言（承認＝了承のみ）。
 */
import { z } from 'zod';

/** 役割×モデル別のコスト行。 */
export const CostByRoleModelSchema = z.object({
  role: z.string(),
  provider: z.string(),
  model: z.string(),
  cost_jpy: z.number(),
  calls: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  image_count: z.number().int().nonnegative().default(0),
});
export type CostByRoleModel = z.infer<typeof CostByRoleModelSchema>;

/** 現行のモデル割当。 */
export const CurrentAssignmentSchema = z.object({
  role: z.string(),
  genre: z.string().nullable().default(null),
  provider: z.string(),
  model: z.string(),
});
export type CurrentAssignment = z.infer<typeof CurrentAssignmentSchema>;

/** 単価カタログ行（現行）。 */
export const CatalogPriceSchema = z.object({
  provider: z.string(),
  model: z.string(),
  input_price_per_mtok_usd: z.number().nullable().default(null),
  output_price_per_mtok_usd: z.number().nullable().default(null),
  image_price_per_image_usd: z.number().nullable().default(null),
});
export type CatalogPrice = z.infer<typeof CatalogPriceSchema>;

export const CostOptimizerInputSchema = z.object({
  period_label: z.string(),
  total_cost_jpy: z.number(),
  by_role_model: z.array(CostByRoleModelSchema).default([]),
  current_assignments: z.array(CurrentAssignmentSchema).default([]),
  catalog: z.array(CatalogPriceSchema).default([]),
  /** 運用設定サマリ（cron / トグル）。key→現在値。 */
  settings: z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])).default({}),
});
export type CostOptimizerInput = z.infer<typeof CostOptimizerInputSchema>;

/** 実行アクション（安全・可逆のみ）。 */
export const ProposalActionSchema = z.object({
  kind: z.enum(['switch_model_assignment', 'set_app_setting', 'advisory']).default('advisory'),
  /** switch_model_assignment 用。 */
  role: z.string().optional(),
  genre: z.string().nullable().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  /** set_app_setting 用。 */
  key: z.string().optional(),
  value: z.union([z.string(), z.boolean(), z.number()]).optional(),
});
export type ProposalAction = z.infer<typeof ProposalActionSchema>;

export const CostProposalSchema = z.object({
  category: z.enum(['model', 'cadence', 'feature', 'other']).default('other'),
  title: z.string().min(1),
  description: z.string().default(''),
  /** 月あたりの推定削減額（円）。不明なら 0。 */
  estimated_saving_jpy: z.number().int().default(0),
  /** 影響・リスクの説明（品質への影響など）。 */
  impact_note: z.string().default(''),
  action: ProposalActionSchema.default({ kind: 'advisory' }),
});
export type CostProposal = z.infer<typeof CostProposalSchema>;

/** LLM 形状ドリフト正規化: 配列直返し / {proposals:[...]} / saving 別名。 */
function normalize(v: unknown): unknown {
  const arr = Array.isArray(v)
    ? v
    : v && typeof v === 'object'
      ? ((v as Record<string, unknown>).proposals ??
        (v as Record<string, unknown>).items ??
        (v as Record<string, unknown>).suggestions)
      : undefined;
  if (!Array.isArray(arr)) return v;
  return {
    proposals: arr.map((r) => {
      if (!r || typeof r !== 'object') return r;
      const o = r as Record<string, unknown>;
      return {
        category: o.category ?? 'other',
        title: o.title ?? o.name ?? '',
        description: o.description ?? o.detail ?? '',
        estimated_saving_jpy: o.estimated_saving_jpy ?? o.saving_jpy ?? o.estimated_saving ?? 0,
        impact_note: o.impact_note ?? o.impact ?? o.risk ?? '',
        action: o.action ?? { kind: 'advisory' },
      };
    }),
  };
}

export const CostOptimizerOutputSchema = z.preprocess(
  normalize,
  z.object({
    proposals: z.array(CostProposalSchema).default([]),
  }),
);
export type CostOptimizerOutput = z.infer<typeof CostOptimizerOutputSchema>;
