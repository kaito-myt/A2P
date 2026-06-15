/**
 * 評価履歴タブ (T-10-06) のシリアライズ / ビューヘルパ。
 *
 * RSC で Prisma EvalResult を Client Component に渡す際の
 * Date/Json 正規化。books-view と同パターン。
 */
import { z } from 'zod';

import type { EvalResult } from '@a2p/db';

import { messages } from './messages';

// ---------------------------------------------------------------------------
// Score breakdown: 6 軸スコア
// ---------------------------------------------------------------------------

export const ScoreBreakdownSchema = z.object({
  benefit_clarity: z.number().optional(),
  logical_consistency: z.number().optional(),
  style_consistency: z.number().optional(),
  japanese_naturalness: z.number().optional(),
  title_alignment: z.number().optional(),
  genre_fit: z.number().optional(),
});

export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

export const SCORE_AXES = [
  'benefit_clarity',
  'logical_consistency',
  'style_consistency',
  'japanese_naturalness',
  'title_alignment',
  'genre_fit',
] as const;

export type ScoreAxis = (typeof SCORE_AXES)[number];

export function parseScoreBreakdown(json: unknown): ScoreBreakdown {
  const r = ScoreBreakdownSchema.safeParse(json);
  return r.success ? r.data : {};
}

// ---------------------------------------------------------------------------
// Judge comments: Record<axis, string>
// ---------------------------------------------------------------------------

export function parseJudgeComments(json: unknown): Record<string, string> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(json)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// triggered_by helpers
// ---------------------------------------------------------------------------

const m = messages.books.evaluation;

export function parseTriggeredBy(triggered_by: string): {
  label: string;
  revisionRunId: string | null;
} {
  if (triggered_by === 'auto') {
    return { label: m.triggeredByAuto, revisionRunId: null };
  }
  if (triggered_by === 'manual') {
    return { label: m.triggeredByManual, revisionRunId: null };
  }
  if (triggered_by.startsWith('revision_run:')) {
    const id = triggered_by.slice('revision_run:'.length);
    return { label: m.triggeredByRevision, revisionRunId: id };
  }
  return { label: triggered_by, revisionRunId: null };
}

// ---------------------------------------------------------------------------
// Serialized type
// ---------------------------------------------------------------------------

export interface EvalResultSerialized {
  id: string;
  book_id: string;
  score_total: number;
  score_breakdown: ScoreBreakdown;
  judge_comments: Record<string, string>;
  triggered_by: string;
  judged_at: string;
}

type RawEvalResult = Pick<
  EvalResult,
  | 'id'
  | 'book_id'
  | 'score_total'
  | 'score_breakdown_json'
  | 'judge_comments_json'
  | 'triggered_by'
  | 'judged_at'
>;

export function serializeEvalResult(raw: RawEvalResult): EvalResultSerialized {
  return {
    id: raw.id,
    book_id: raw.book_id,
    score_total: raw.score_total,
    score_breakdown: parseScoreBreakdown(raw.score_breakdown_json),
    judge_comments: parseJudgeComments(raw.judge_comments_json),
    triggered_by: raw.triggered_by,
    judged_at: raw.judged_at.toISOString(),
  };
}

export function serializeEvalResults(raws: RawEvalResult[]): EvalResultSerialized[] {
  return raws.map(serializeEvalResult);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export const SCORE_LOW_THRESHOLD = 80;

export function isLowScore(score_total: number): boolean {
  return score_total < SCORE_LOW_THRESHOLD;
}

export function formatScoreAxis(axis: string): string {
  const axes = m.scoreAxes as Record<string, string>;
  return axes[axis] ?? axis;
}
