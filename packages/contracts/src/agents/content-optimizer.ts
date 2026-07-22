/**
 * F-061 — 日次 SNS 投稿見直し担当 (content_optimizer) の I/O 契約。
 *
 * 毎日1回、予定投稿(scheduled)の本文を、アカウント戦略・直近の投稿傾向を踏まえて
 * 推敲・改善する。将来的に実インプレッション/トレンドハッシュタグを差し込めるよう
 * `signals` を任意で受け取る（v1 は未指定で戦略＋直近投稿ベース）。
 *
 * 出力は generateObject ではなく generateText + extractLlmJson で受けるため、
 * LLM の形状ドリフトに強い z.preprocess 正規化を入れる（sns_strategist と同方針）。
 */
import { z } from 'zod';

import { GenreValueSchema } from '../genres.js';

/** 見直し対象の1投稿（下書き/予定）。 */
export const OptimizerDraftSchema = z.object({
  id: z.string().min(1),
  /** 'promo'(販促) | 'value'(育成)。販促は購入導線/URL を保持する。 */
  kind: z.string().default('value'),
  body: z.string().min(1),
});
export type OptimizerDraft = z.infer<typeof OptimizerDraftSchema>;

/** 外部シグナル（任意・将来接続用）。 */
export const OptimizerSignalsSchema = z.object({
  /** トレンドのハッシュタグ候補（ニッチに合うもの）。 */
  trending_hashtags: z.array(z.string()).default([]),
  /** 直近投稿のインプレッション要約（例: 「フック型が伸びた」）。 */
  engagement_notes: z.array(z.string()).default([]),
});
export type OptimizerSignals = z.infer<typeof OptimizerSignalsSchema>;

export const ContentOptimizerInputSchema = z.object({
  channel: z.string().min(1),
  genre: GenreValueSchema.nullable().optional(),
  /** アカウントのコンセプト（戦略より）。 */
  concept: z.string().default(''),
  /** トーン&マナー。 */
  tone_of_voice: z.string().default(''),
  /** 定番ハッシュタグ（戦略の core）。 */
  hashtag_core: z.array(z.string()).default([]),
  /** 直近の投稿済み本文（傾向把握用の例示、売り込みの参考にはしない）。 */
  recent_posted: z.array(z.string()).default([]),
  /** 見直し対象の予定投稿。 */
  drafts: z.array(OptimizerDraftSchema).min(1),
  /** 外部シグナル（任意）。 */
  signals: OptimizerSignalsSchema.optional(),
});
export type ContentOptimizerInput = z.infer<typeof ContentOptimizerInputSchema>;

/** 1投稿の見直し結果。 */
export const OptimizerRevisionSchema = z.object({
  id: z.string().min(1),
  /** 改善したか（false なら元のまま据え置き）。 */
  changed: z.boolean().default(false),
  /** 改善後の本文（changed=false でも元本文をそのまま返してよい）。 */
  revised_body: z.string().min(1),
  /** 変更理由（無くても可）。 */
  reason: z.string().default(''),
});
export type OptimizerRevision = z.infer<typeof OptimizerRevisionSchema>;

/** LLM 出力形状ドリフトの正規化: 配列直返し / {revisions:[...]} / body 別名を吸収。 */
function normalizeOutput(v: unknown): unknown {
  if (Array.isArray(v)) return { revisions: v };
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const arr = (o.revisions ?? o.posts ?? o.results ?? o.items) as unknown;
    if (Array.isArray(arr)) {
      return {
        revisions: arr.map((r) => {
          if (!r || typeof r !== 'object') return r;
          const rr = r as Record<string, unknown>;
          return {
            id: rr.id ?? rr.post_id ?? rr.draft_id,
            changed: rr.changed ?? rr.is_changed ?? (rr.revised_body !== undefined || rr.body !== undefined),
            revised_body: rr.revised_body ?? rr.body ?? rr.text ?? rr.content,
            reason: rr.reason ?? rr.note ?? '',
          };
        }),
      };
    }
  }
  return v;
}

export const ContentOptimizerOutputSchema = z.preprocess(
  normalizeOutput,
  z.object({
    revisions: z.array(OptimizerRevisionSchema).default([]),
  }),
);
export type ContentOptimizerOutput = z.infer<typeof ContentOptimizerOutputSchema>;
