/**
 * PromotionPlan (promotion_plans.plan_json) の defensive パーサ + serialized 型。
 *
 * Prisma Json → Client Component 用の型付きオブジェクト。破損データでも UI を壊さない
 * よう全フィールドを optional に倒す。
 */
import { z } from 'zod';

const LaunchTask = z.object({ task: z.string().optional(), timing: z.string().optional() });
const OngoingAction = z.object({ when: z.string().optional(), action: z.string().optional() });

export const PromotionPlanViewSchema = z.object({
  summary: z.string().optional(),
  pricing: z
    .object({
      launch_price_jpy: z.number().optional(),
      regular_price_jpy: z.number().optional(),
      kdp_select_recommended: z.boolean().optional(),
      tactics: z.array(z.string()).optional(),
    })
    .optional(),
  category_keyword_actions: z.array(z.string()).optional(),
  review_actions: z.array(z.string()).optional(),
  launch_checklist: z.array(LaunchTask).optional(),
  promo_copy: z
    .object({
      x_posts: z.array(z.string()).optional(),
      note_article: z.string().optional(),
      blog_outline: z.string().optional(),
    })
    .optional(),
  ongoing_calendar: z.array(OngoingAction).optional(),
});
export type PromotionPlanView = z.infer<typeof PromotionPlanViewSchema>;

export function parsePromotionPlan(json: unknown): PromotionPlanView | null {
  if (json === null || json === undefined || typeof json !== 'object') return null;
  const r = PromotionPlanViewSchema.safeParse(json);
  return r.success ? r.data : null;
}

export interface PromotionBookRow {
  id: string;
  title: string;
  author: string;
  status: string;
  hasPlan: boolean;
  updatedAt: string | null;
}
