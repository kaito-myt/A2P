/**
 * S-010 書籍詳細 (T-04-09) のシリアライズ / ビューヘルパ。
 *
 * RSC で Prisma Book (+ join) を Client Component に渡す際の
 * Date/Decimal/Json 正規化。outlines-view / themes-view と同パターン。
 */
import { z } from 'zod';

import type { Book, Outline, Chapter, Job, RevisionComment } from '@a2p/db';

import { messages } from './messages';

// ---------------------------------------------------------------------------
// Book status helpers
// ---------------------------------------------------------------------------

export type BookStatus =
  | 'queued'
  | 'running'
  | 'editing'
  | 'content_review'
  | 'judging'
  | 'thumbnail'
  | 'exporting'
  | 'done'
  | 'needs_human_review'
  | 'failed'
  | 'cancelled'
  | 'paused_cost';

const KNOWN_BOOK_STATUSES = new Set<string>([
  'queued',
  'running',
  'editing',
  'content_review',
  'judging',
  'thumbnail',
  'exporting',
  'done',
  'needs_human_review',
  'failed',
  'cancelled',
  'paused_cost',
]);

export function normalizeBookStatus(s: string): BookStatus {
  return KNOWN_BOOK_STATUSES.has(s) ? (s as BookStatus) : 'queued';
}

export type CostStatus = 'normal' | 'warn' | 'paused' | 'exceeded';

const KNOWN_COST_STATUSES = new Set<string>(['normal', 'warn', 'paused', 'exceeded']);

export function normalizeCostStatus(s: string): CostStatus {
  return KNOWN_COST_STATUSES.has(s) ? (s as CostStatus) : 'normal';
}

// ---------------------------------------------------------------------------
// Outline chapter plan (shared with outlines-view but re-exported here for
// self-containment of books-view)
// ---------------------------------------------------------------------------

export const OutlineChapterPlanSchema = z.object({
  index: z.number().int().optional(),
  heading: z.string().min(1),
  summary: z.string().optional(),
  target_chars: z.number().int().optional(),
  subheadings: z.array(z.string()).optional(),
});
export type OutlineChapterPlan = z.infer<typeof OutlineChapterPlanSchema>;

export function parseOutlineChapters(json: unknown): OutlineChapterPlan[] {
  if (!Array.isArray(json)) return [];
  const out: OutlineChapterPlan[] = [];
  for (const item of json) {
    const r = OutlineChapterPlanSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Outline status (same values as outlines-view)
// ---------------------------------------------------------------------------

export type OutlineStatus = 'draft' | 'pending_review' | 'approved' | 'rejected';

const KNOWN_OUTLINE_STATUSES = new Set<string>(['draft', 'pending_review', 'approved', 'rejected']);

export function normalizeOutlineStatus(s: string): OutlineStatus {
  return KNOWN_OUTLINE_STATUSES.has(s) ? (s as OutlineStatus) : 'draft';
}

// ---------------------------------------------------------------------------
// Job status
// ---------------------------------------------------------------------------

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

const KNOWN_JOB_STATUSES = new Set<string>(['queued', 'running', 'done', 'failed', 'cancelled']);

export function normalizeJobStatus(s: string): JobStatus {
  return KNOWN_JOB_STATUSES.has(s) ? (s as JobStatus) : 'queued';
}

// ---------------------------------------------------------------------------
// S-009 Library row (lighter than BookDetailSerialized)
// ---------------------------------------------------------------------------

export interface BookArtifactSerialized {
  id: string;
  kind: string;
}

export type PublishStatus = 'unlisted' | 'published';

export interface BookRowSerialized {
  id: string;
  title: string;
  status: BookStatus;
  publish_status: PublishStatus;
  cost_status: CostStatus;
  cost_jpy_total: number;
  has_pending_comments: boolean;
  has_blocking_comments: boolean;
  updated_at: string;
  created_at: string;
  account: {
    id: string;
    pen_name: string;
  };
  genre: string | null;
  artifacts: BookArtifactSerialized[];
}

type RawBookForRow = Pick<
  import('@a2p/db').Book,
  | 'id'
  | 'title'
  | 'status'
  | 'publish_status'
  | 'cost_status'
  | 'cost_jpy_total'
  | 'has_pending_comments'
  | 'has_blocking_comments'
  | 'updated_at'
  | 'created_at'
> & {
  account: Pick<import('@a2p/db').Account, 'id' | 'pen_name'>;
  theme?: { genre: string | null } | null;
  artifacts?: Pick<import('@a2p/db').Artifact, 'id' | 'kind'>[];
};

export function serializeBookRow(raw: RawBookForRow): BookRowSerialized {
  return {
    id: raw.id,
    title: raw.title,
    status: normalizeBookStatus(raw.status),
    publish_status: raw.publish_status === 'published' ? 'published' : 'unlisted',
    cost_status: normalizeCostStatus(raw.cost_status),
    cost_jpy_total: Number(raw.cost_jpy_total),
    has_pending_comments: raw.has_pending_comments,
    has_blocking_comments: raw.has_blocking_comments,
    updated_at: raw.updated_at.toISOString(),
    created_at: raw.created_at.toISOString(),
    account: {
      id: raw.account.id,
      pen_name: raw.account.pen_name,
    },
    genre: raw.theme?.genre ?? null,
    artifacts: (raw.artifacts ?? []).map((a) => ({
      id: a.id,
      kind: a.kind,
    })),
  };
}

/** Find the artifact ID for a given kind (docx/pdf/png_cover). */
export function findArtifactByKind(
  artifacts: readonly BookArtifactSerialized[],
  kind: string,
): string | undefined {
  return artifacts.find((a) => a.kind === kind)?.id;
}

// ---------------------------------------------------------------------------
// Serialized types (detail)
// ---------------------------------------------------------------------------

export interface BookOutlineSerialized {
  id: string;
  status: OutlineStatus;
  reject_note: string | null;
  approved_at: string | null;
  created_at: string;
  chapters: OutlineChapterPlan[];
  total_target_chars: number;
}

export interface BookChapterSerialized {
  id: string;
  index: number;
  heading: string;
  body_md: string;
  status: string;
  char_count: number;
  version: number;
  updated_at: string;
}

export interface BookJobSerialized {
  id: string;
  kind: string;
  status: JobStatus;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  error: string | null;
  retries: number;
}

export interface RevisionCommentSerialized {
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

export interface BookDetailSerialized {
  id: string;
  title: string;
  subtitle: string | null;
  asin: string | null;
  status: BookStatus;
  cost_status: CostStatus;
  cost_jpy_total: number;
  has_pending_comments: boolean;
  has_blocking_comments: boolean;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  account: {
    id: string;
    pen_name: string;
  };
  genre: string | null;
  outline: BookOutlineSerialized | null;
  chapters: BookChapterSerialized[];
  jobs: BookJobSerialized[];
  comments: RevisionCommentSerialized[];
  covers: BookCoverSerialized[];
}

export interface BookCoverSerialized {
  id: string;
  status: string;
  /** `<img src>` 用の画像配信エンドポイント。 */
  imageUrl: string;
  /** 生成コスト (¥)。generation_meta_json.cost_jpy から。 */
  costJpy: number | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

type RawBookForDetail = Pick<
  Book,
  | 'id'
  | 'title'
  | 'subtitle'
  | 'asin'
  | 'status'
  | 'cost_status'
  | 'cost_jpy_total'
  | 'has_pending_comments'
  | 'has_blocking_comments'
  | 'created_at'
  | 'updated_at'
  | 'done_at'
> & {
  account: Pick<import('@a2p/db').Account, 'id' | 'pen_name'>;
  theme?: { genre: string | null } | null;
  outline?:
    | (Pick<
        Outline,
        'id' | 'status' | 'reject_note' | 'approved_at' | 'created_at' | 'chapters_json'
      >)
    | null;
  chapters?: Pick<Chapter, 'id' | 'index' | 'heading' | 'body_md' | 'status' | 'char_count' | 'version' | 'updated_at'>[];
  jobs?: Pick<Job, 'id' | 'kind' | 'status' | 'started_at' | 'finished_at' | 'created_at' | 'error' | 'retries'>[];
  revisionComments?: Pick<RevisionComment, 'id' | 'book_id' | 'target_kind' | 'target_id' | 'range_json' | 'body' | 'priority' | 'status' | 'created_at' | 'applied_at'>[];
  covers?: Array<{ id: string; status: string; created_at: Date; generation_meta_json: unknown }>;
};

export function serializeBookDetail(raw: RawBookForDetail): BookDetailSerialized {
  const outline = raw.outline
    ? serializeOutline(raw.outline)
    : null;

  const chapters = (raw.chapters ?? [])
    .slice()
    .sort((a, b) => a.index - b.index)
    .map(serializeChapter);

  const jobs = (raw.jobs ?? [])
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .map(serializeJob);

  const comments = (raw.revisionComments ?? []).map(serializeRevisionComment);

  const covers = (raw.covers ?? [])
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .map((cv): BookCoverSerialized => {
      const meta = (cv.generation_meta_json ?? {}) as { cost_jpy?: unknown };
      const cost = typeof meta.cost_jpy === 'number' ? meta.cost_jpy : null;
      return {
        id: cv.id,
        status: cv.status,
        imageUrl: `/api/covers/${cv.id}/image`,
        costJpy: cost,
        created_at: new Date(cv.created_at).toISOString(),
      };
    });

  return {
    id: raw.id,
    title: raw.title,
    subtitle: raw.subtitle ?? null,
    asin: raw.asin ?? null,
    status: normalizeBookStatus(raw.status),
    cost_status: normalizeCostStatus(raw.cost_status),
    cost_jpy_total: Number(raw.cost_jpy_total),
    has_pending_comments: raw.has_pending_comments,
    has_blocking_comments: raw.has_blocking_comments,
    created_at: raw.created_at.toISOString(),
    updated_at: raw.updated_at.toISOString(),
    done_at: raw.done_at ? raw.done_at.toISOString() : null,
    account: {
      id: raw.account.id,
      pen_name: raw.account.pen_name,
    },
    genre: raw.theme?.genre ?? null,
    outline,
    chapters,
    jobs,
    comments,
    covers,
  };
}

function serializeOutline(
  o: Pick<Outline, 'id' | 'status' | 'reject_note' | 'approved_at' | 'created_at' | 'chapters_json'>,
): BookOutlineSerialized {
  const chapters = parseOutlineChapters(o.chapters_json);
  const total = chapters.reduce(
    (acc, c) =>
      acc + (typeof c.target_chars === 'number' && Number.isFinite(c.target_chars) ? c.target_chars : 0),
    0,
  );
  return {
    id: o.id,
    status: normalizeOutlineStatus(o.status),
    reject_note: o.reject_note ?? null,
    approved_at: o.approved_at ? o.approved_at.toISOString() : null,
    created_at: o.created_at.toISOString(),
    chapters,
    total_target_chars: total,
  };
}

function serializeChapter(
  c: Pick<Chapter, 'id' | 'index' | 'heading' | 'body_md' | 'status' | 'char_count' | 'version' | 'updated_at'>,
): BookChapterSerialized {
  return {
    id: c.id,
    index: c.index,
    heading: c.heading,
    body_md: c.body_md,
    status: c.status,
    char_count: c.char_count,
    version: c.version,
    updated_at: c.updated_at.toISOString(),
  };
}

function serializeJob(
  j: Pick<Job, 'id' | 'kind' | 'status' | 'started_at' | 'finished_at' | 'created_at' | 'error' | 'retries'>,
): BookJobSerialized {
  return {
    id: j.id,
    kind: j.kind,
    status: normalizeJobStatus(j.status),
    started_at: j.started_at ? j.started_at.toISOString() : null,
    finished_at: j.finished_at ? j.finished_at.toISOString() : null,
    created_at: j.created_at.toISOString(),
    error: j.error ?? null,
    retries: j.retries,
  };
}

function serializeRevisionComment(
  c: Pick<RevisionComment, 'id' | 'book_id' | 'target_kind' | 'target_id' | 'range_json' | 'body' | 'priority' | 'status' | 'created_at' | 'applied_at'>,
): RevisionCommentSerialized {
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
    applied_at: c.applied_at ? c.applied_at.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Display helpers (pure functions)
// ---------------------------------------------------------------------------

const m = messages.books;

export function formatBookStatus(status: BookStatus): string {
  return m.status[status] ?? status;
}

export function formatCostStatus(status: CostStatus): string {
  return m.costStatus[status] ?? status;
}

export function formatGenre(genre: string | null | undefined): string | null {
  if (!genre) return null;
  const g = m.genres as Record<string, string>;
  return g[genre] ?? genre;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day} ${hh}:${mm}`;
}

/**
 * Cost threshold display helpers for the 500/750 yen line in BookHeader.
 */
export const COST_THRESHOLD_WARN = 500;
export const COST_THRESHOLD_PAUSE = 750;

export function costThresholdPercent(costJpy: number, threshold: number): number {
  if (threshold <= 0) return 0;
  return Math.min(100, Math.round((costJpy / threshold) * 100));
}

export function formatJobKind(kind: string): string {
  const mapping = m.jobKinds as Record<string, string>;
  return mapping[kind] ?? kind;
}
