/**
 * F-053 — バエオフ画面の共有型・定数。
 */

/** 比較対象にできる役割 (テキスト生成系)。 */
export const BAKEOFF_ROLES = [
  'writer',
  'marketer',
  'editor',
  'promoter',
  'outline_review',
  'thumbnail_text',
  'judge',
  'cover_art_direction',
] as const;
export type BakeoffRole = (typeof BAKEOFF_ROLES)[number];

export const BAKEOFF_GENRES = ['practical', 'business', 'self_help'] as const;

export interface CandidateModel {
  provider: string;
  model: string;
}

export interface BakeoffResultRow {
  id: string;
  provider: string;
  model: string;
  outputText: string | null;
  qualityScore: number | null;
  rank: number | null;
  rationale: string | null;
  costJpy: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface BakeoffRunRow {
  id: string;
  role: string;
  genre: string | null;
  inputLabel: string;
  status: string;
  createdAt: string | null;
  results: BakeoffResultRow[];
}
