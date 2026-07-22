/**
 * S-012 サムネ承認 (T-05-10) のシリアライズ + ヘルパ。
 *
 * RSC で Prisma `Cover` / `CoverTextProposal` (+ Book join) を
 * Client Component に渡す際に Date / Decimal をシリアライズする。
 * (outlines-view.ts / themes-view.ts と同パターン)
 */

import type { Cover, CoverTextProposal, Book, RevisionComment } from '@a2p/db';

import { genreLabel } from '@a2p/contracts';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// Cover row serialized
// ---------------------------------------------------------------------------

export type CoverStatus = 'generated' | 'adopted' | 'rejected';

function statusOf(s: string): CoverStatus {
  if (s === 'generated' || s === 'adopted' || s === 'rejected') return s;
  return 'generated';
}

export interface CoverRowSerialized {
  id: string;
  book_id: string;
  cover_text_id: string | null;
  r2_key: string;
  artifact_id: string | null;
  prompt_used: string;
  width: number;
  height: number;
  status: CoverStatus;
  generation_meta_json: unknown;
  created_at: string;
}

export function serializeCover(
  row: Pick<
    Cover,
    | 'id'
    | 'book_id'
    | 'cover_text_id'
    | 'r2_key'
    | 'artifact_id'
    | 'prompt_used'
    | 'width'
    | 'height'
    | 'status'
    | 'generation_meta_json'
    | 'created_at'
  >,
): CoverRowSerialized {
  return {
    id: row.id,
    book_id: row.book_id,
    cover_text_id: row.cover_text_id,
    r2_key: row.r2_key,
    artifact_id: row.artifact_id,
    prompt_used: row.prompt_used,
    width: row.width,
    height: row.height,
    status: statusOf(row.status),
    generation_meta_json: row.generation_meta_json,
    created_at: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CoverTextProposal serialized
// ---------------------------------------------------------------------------

export type CoverTextStatus = 'proposed' | 'adopted' | 'rejected';

function textStatusOf(s: string): CoverTextStatus {
  if (s === 'proposed' || s === 'adopted' || s === 'rejected') return s;
  return 'proposed';
}

export interface CoverTextProposalSerialized {
  id: string;
  book_id: string;
  title: string;
  subtitle: string | null;
  band_copy: string | null;
  status: CoverTextStatus;
  created_at: string;
}

export function serializeCoverTextProposal(
  row: Pick<
    CoverTextProposal,
    'id' | 'book_id' | 'title' | 'subtitle' | 'band_copy' | 'status' | 'created_at'
  >,
): CoverTextProposalSerialized {
  return {
    id: row.id,
    book_id: row.book_id,
    title: row.title,
    subtitle: row.subtitle,
    band_copy: row.band_copy,
    status: textStatusOf(row.status),
    created_at: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Cover comment serialized (T-06-04)
// ---------------------------------------------------------------------------

export interface CoverCommentSerialized {
  id: string;
  book_id: string;
  target_kind: string;
  target_id: string;
  range_json: Record<string, unknown> | null;
  body: string;
  priority: string;
  status: string;
  created_at: string;
  applied_at: string | null;
}

export function serializeCoverComment(
  c: Pick<RevisionComment, 'id' | 'book_id' | 'target_kind' | 'target_id' | 'range_json' | 'body' | 'priority' | 'status' | 'created_at' | 'applied_at'>,
): CoverCommentSerialized {
  return {
    id: c.id,
    book_id: c.book_id,
    target_kind: c.target_kind,
    target_id: c.target_id,
    range_json: (c.range_json as Record<string, unknown>) ?? null,
    body: c.body,
    priority: c.priority,
    status: c.status,
    created_at: c.created_at.toISOString(),
    applied_at: c.applied_at?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Book + covers grouped row
// ---------------------------------------------------------------------------

export interface BookCoverGroup {
  book: {
    id: string;
    title: string;
    subtitle: string | null;
    account_id: string;
    status: string;
    genre: string | null;
  };
  covers: CoverRowSerialized[];
  coverTextProposals: CoverTextProposalSerialized[];
  comments: CoverCommentSerialized[];
}

export function serializeBookCoverGroup(
  raw: Pick<Book, 'id' | 'title' | 'subtitle' | 'account_id' | 'status'> & {
    theme?: { genre: string | null } | null;
    covers: Array<
      Pick<
        Cover,
        | 'id'
        | 'book_id'
        | 'cover_text_id'
        | 'r2_key'
        | 'artifact_id'
        | 'prompt_used'
        | 'width'
        | 'height'
        | 'status'
        | 'generation_meta_json'
        | 'created_at'
      >
    >;
    coverTextProposals: Array<
      Pick<
        CoverTextProposal,
        'id' | 'book_id' | 'title' | 'subtitle' | 'band_copy' | 'status' | 'created_at'
      >
    >;
    revisionComments?: Array<
      Pick<RevisionComment, 'id' | 'book_id' | 'target_kind' | 'target_id' | 'range_json' | 'body' | 'priority' | 'status' | 'created_at' | 'applied_at'>
    >;
  },
): BookCoverGroup {
  const coverComments = (raw.revisionComments ?? [])
    .filter((c) => c.target_kind === 'cover' || c.target_kind === 'cover_text')
    .map(serializeCoverComment);

  return {
    book: {
      id: raw.id,
      title: raw.title,
      subtitle: raw.subtitle,
      account_id: raw.account_id,
      status: raw.status,
      genre: raw.theme?.genre ?? null,
    },
    covers: raw.covers.map(serializeCover),
    coverTextProposals: raw.coverTextProposals.map(serializeCoverTextProposal),
    comments: coverComments,
  };
}

// ---------------------------------------------------------------------------
// Summary (for header KPI)
// ---------------------------------------------------------------------------

export interface CoversSummary {
  /** Books with at least one 'generated' cover (= pending approval). */
  pendingBooks: number;
  /** Total covers with status='generated'. */
  totalCovers: number;
}

export function summarizeCovers(groups: readonly BookCoverGroup[]): CoversSummary {
  let pendingBooks = 0;
  let totalCovers = 0;
  for (const g of groups) {
    const gen = g.covers.filter((c) => c.status === 'generated');
    if (gen.length > 0) pendingBooks++;
    totalCovers += gen.length;
  }
  return { pendingBooks, totalCovers };
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

/**
 * From a set of selected book IDs, collect cover IDs that are 'generated'
 * (= eligible for bulk adopt). Returns one cover per book (the first generated).
 */
export function pickEligibleCoverIds(
  groups: readonly BookCoverGroup[],
  selectedBookIds: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const g of groups) {
    if (!selectedBookIds.has(g.book.id)) continue;
    const firstGenerated = g.covers.find((c) => c.status === 'generated');
    if (firstGenerated) out.push(firstGenerated.id);
  }
  return out;
}

/**
 * Collect all book_ids that have at least one 'generated' cover.
 */
export function booksWithGeneratedCovers(
  groups: readonly BookCoverGroup[],
): string[] {
  return groups
    .filter((g) => g.covers.some((c) => c.status === 'generated'))
    .map((g) => g.book.id);
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

export function formatGenre(genre: string | null | undefined): string | null {
  if (!genre) return null;
  const g = messages.covers.genres as Record<string, string>;
  // ローカル辞書 → カタログ (全ジャンル) → 素通し の順にラベル解決。
  return g[genre] ?? genreLabel(genre);
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

/**
 * Extract cost_jpy from Cover.generation_meta_json defensively.
 */
export function extractCoverCost(meta: unknown): number | null {
  if (meta && typeof meta === 'object' && 'cost_jpy' in meta) {
    const v = (meta as Record<string, unknown>).cost_jpy;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Extract model name from Cover.generation_meta_json defensively.
 */
export function extractCoverModel(meta: unknown): string | null {
  if (meta && typeof meta === 'object' && 'model' in meta) {
    const v = (meta as Record<string, unknown>).model;
    if (typeof v === 'string') return v;
  }
  return null;
}
