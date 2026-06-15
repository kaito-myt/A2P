/**
 * S-014 修正一括反映 進捗・diff レビュー (T-06-09) のシリアライズ / ビューヘルパ。
 *
 * RSC で Prisma RevisionRun (+ comments + chapters + chapterRevisions + tokenUsage)
 * を Client Component に渡すための Date/Json/Decimal 正規化と
 * diff 計算の純粋関数群。
 *
 * outlines-view / comments-view と同パターン。
 */

import type { CommentPriority, CommentStatus, TargetKind } from './comment-helpers';
import { formatCostJpy, formatTokenCount } from './cost-view';

export { formatCostJpy, formatTokenCount };

// ---------------------------------------------------------------------------
// RevisionRun status
// ---------------------------------------------------------------------------

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'partial';

const KNOWN_RUN_STATUSES = new Set<string>(['queued', 'running', 'done', 'failed', 'partial']);

export function normalizeRunStatus(s: string): RunStatus {
  return KNOWN_RUN_STATUSES.has(s) ? (s as RunStatus) : 'queued';
}

// ---------------------------------------------------------------------------
// Serialized types (RSC -> Client boundary)
// ---------------------------------------------------------------------------

export interface RunCommentSerialized {
  id: string;
  book_id: string;
  book_title: string;
  target_kind: TargetKind;
  target_id: string;
  body: string;
  priority: CommentPriority;
  status: CommentStatus;
  application_result_json: ApplicationResult | null;
  created_at: string;
  applied_at: string | null;
}

export interface ApplicationResult {
  reason?: string;
  new_target_id?: string;
  diff_summary?: string;
}

export interface RunBookSerialized {
  id: string;
  title: string;
}

export interface ChapterDiffData {
  chapter_id: string;
  chapter_index: number;
  chapter_heading: string;
  old_body_md: string;
  new_body_md: string;
}

export interface RunCostRow {
  provider: string;
  model: string;
  role: string;
  input_tokens: number;
  output_tokens: number;
  cost_jpy: number;
  call_count: number;
}

export interface ResultSummary {
  applied: number;
  not_applicable: number;
  failed: number;
  cost_jpy: number;
  blocked_books?: string[];
}

export interface RevisionRunSerialized {
  id: string;
  triggered_at: string;
  started_at: string | null;
  finished_at: string | null;
  status: RunStatus;
  book_ids: string[];
  comment_ids: string[];
  result_summary: ResultSummary;
  error: string | null;
  comments: RunCommentSerialized[];
  books: RunBookSerialized[];
  chapter_diffs: ChapterDiffData[];
  cost_rows: RunCostRow[];
  cost_total_jpy: number;
}

// ---------------------------------------------------------------------------
// Raw types (Prisma query result shapes)
// ---------------------------------------------------------------------------

interface RawRevisionRun {
  id: string;
  triggered_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  status: string;
  book_ids_json: unknown;
  comment_ids_json: unknown;
  result_summary_json: unknown;
  error: string | null;
}

interface RawRunComment {
  id: string;
  book_id: string;
  target_kind: string;
  target_id: string;
  body: string;
  priority: string;
  status: string;
  application_result_json: unknown;
  created_at: Date;
  applied_at: Date | null;
  book: { id: string; title: string };
}

interface RawChapterForDiff {
  id: string;
  index: number;
  heading: string;
  body_md: string;
}

interface RawChapterRevision {
  chapter_id: string;
  version: number;
  body_md: string;
}

interface RawCostGroupBy {
  provider: string;
  model: string;
  role: string;
  _sum: {
    input_tokens: number | null;
    output_tokens: number | null;
    cost_jpy: unknown;
  };
  _count: { _all: number };
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

const VALID_TARGET_KINDS = new Set<string>([
  'chapter', 'outline', 'cover', 'cover_text', 'metadata', 'theme',
]);
const VALID_PRIORITIES = new Set<string>(['must', 'should', 'may']);
const VALID_STATUSES = new Set<string>([
  'pending', 'applied', 'not_applicable', 'superseded',
]);

export function serializeRevisionRun(
  run: RawRevisionRun,
  rawComments: RawRunComment[],
  books: { id: string; title: string }[],
  chapters: RawChapterForDiff[],
  chapterRevisions: RawChapterRevision[],
  costGroupBy: RawCostGroupBy[],
): RevisionRunSerialized {
  const bookIds = parseStringArray(run.book_ids_json);
  const commentIds = parseStringArray(run.comment_ids_json);
  const resultSummary = parseResultSummary(run.result_summary_json);

  const comments = rawComments.map(serializeRunComment);

  const chapterDiffs = buildChapterDiffs(chapters, chapterRevisions);

  const costRows = costGroupBy.map(serializeCostRow);
  const costTotalJpy = costRows.reduce((acc, r) => acc + r.cost_jpy, 0);

  return {
    id: run.id,
    triggered_at: run.triggered_at.toISOString(),
    started_at: run.started_at?.toISOString() ?? null,
    finished_at: run.finished_at?.toISOString() ?? null,
    status: normalizeRunStatus(run.status),
    book_ids: bookIds,
    comment_ids: commentIds,
    result_summary: resultSummary,
    error: run.error ?? null,
    comments,
    books: books.map((b) => ({ id: b.id, title: b.title })),
    chapter_diffs: chapterDiffs,
    cost_rows: costRows,
    cost_total_jpy: costTotalJpy,
  };
}

function serializeRunComment(raw: RawRunComment): RunCommentSerialized {
  return {
    id: raw.id,
    book_id: raw.book_id,
    book_title: raw.book.title,
    target_kind: VALID_TARGET_KINDS.has(raw.target_kind)
      ? (raw.target_kind as TargetKind)
      : 'chapter',
    target_id: raw.target_id,
    body: raw.body,
    priority: VALID_PRIORITIES.has(raw.priority)
      ? (raw.priority as CommentPriority)
      : 'may',
    status: VALID_STATUSES.has(raw.status)
      ? (raw.status as CommentStatus)
      : 'pending',
    application_result_json: parseApplicationResult(raw.application_result_json),
    created_at: raw.created_at.toISOString(),
    applied_at: raw.applied_at?.toISOString() ?? null,
  };
}

function serializeCostRow(raw: RawCostGroupBy): RunCostRow {
  return {
    provider: raw.provider,
    model: raw.model,
    role: raw.role,
    input_tokens: raw._sum.input_tokens ?? 0,
    output_tokens: raw._sum.output_tokens ?? 0,
    cost_jpy: toNumber(raw._sum.cost_jpy),
    call_count: raw._count._all,
  };
}

// ---------------------------------------------------------------------------
// Chapter diff builder
// ---------------------------------------------------------------------------

export function buildChapterDiffs(
  currentChapters: RawChapterForDiff[],
  revisions: RawChapterRevision[],
): ChapterDiffData[] {
  const revisionMap = new Map<string, RawChapterRevision>();
  for (const rev of revisions) {
    const existing = revisionMap.get(rev.chapter_id);
    if (!existing || rev.version > existing.version) {
      revisionMap.set(rev.chapter_id, rev);
    }
  }

  const diffs: ChapterDiffData[] = [];
  for (const ch of currentChapters) {
    const rev = revisionMap.get(ch.id);
    if (!rev) continue;
    if (rev.body_md === ch.body_md) continue;
    diffs.push({
      chapter_id: ch.id,
      chapter_index: ch.index,
      chapter_heading: ch.heading,
      old_body_md: rev.body_md,
      new_body_md: ch.body_md,
    });
  }

  diffs.sort((a, b) => a.chapter_index - b.chapter_index);
  return diffs;
}

// ---------------------------------------------------------------------------
// Progress computation
// ---------------------------------------------------------------------------

export interface RunProgress {
  total: number;
  applied: number;
  not_applicable: number;
  pending: number;
  percent: number;
}

export function computeRunProgress(comments: readonly RunCommentSerialized[]): RunProgress {
  const total = comments.length;
  let applied = 0;
  let notApplicable = 0;

  for (const c of comments) {
    if (c.status === 'applied') applied++;
    else if (c.status === 'not_applicable') notApplicable++;
  }

  const processed = applied + notApplicable;
  const pending = total - processed;
  const percent = total > 0 ? Math.round((processed / total) * 100) : 0;

  return { total, applied, not_applicable: notApplicable, pending, percent };
}

/** Per-book progress. */
export interface BookProgress {
  book_id: string;
  book_title: string;
  total: number;
  applied: number;
  not_applicable: number;
  pending: number;
  percent: number;
}

export function computeBookProgress(
  comments: readonly RunCommentSerialized[],
  books: readonly RunBookSerialized[],
): BookProgress[] {
  const bookMap = new Map<string, string>();
  for (const b of books) bookMap.set(b.id, b.title);

  const grouped = new Map<string, RunCommentSerialized[]>();
  for (const c of comments) {
    const existing = grouped.get(c.book_id);
    if (existing) existing.push(c);
    else grouped.set(c.book_id, [c]);
  }

  const result: BookProgress[] = [];
  for (const [bookId, bookComments] of grouped) {
    const total = bookComments.length;
    let applied = 0;
    let notApplicable = 0;

    for (const c of bookComments) {
      if (c.status === 'applied') applied++;
      else if (c.status === 'not_applicable') notApplicable++;
    }

    const processed = applied + notApplicable;
    const pending = total - processed;
    const percent = total > 0 ? Math.round((processed / total) * 100) : 0;

    result.push({
      book_id: bookId,
      book_title: bookMap.get(bookId) ?? bookId,
      total,
      applied,
      not_applicable: notApplicable,
      pending,
      percent,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function formatRunStatus(status: RunStatus): string {
  const labels: Record<RunStatus, string> = {
    queued: '待機中',
    running: '実行中',
    done: '完了',
    failed: '失敗',
    partial: '一部失敗',
  };
  return labels[status] ?? status;
}

export function runStatusVariant(status: RunStatus): 'success' | 'must' | 'should' | 'neutral' {
  switch (status) {
    case 'done':
      return 'success';
    case 'failed':
      return 'must';
    case 'partial':
      return 'should';
    default:
      return 'neutral';
  }
}

export function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  } catch {
    return iso;
  }
}

export function formatElapsedTime(startIso: string, endIso: string | null): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const diffMs = Math.max(0, end - start);
  const totalSeconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Internal parsers
// ---------------------------------------------------------------------------

function parseStringArray(json: unknown): string[] {
  if (Array.isArray(json)) return json.filter((x): x is string => typeof x === 'string');
  return [];
}

function parseResultSummary(json: unknown): ResultSummary {
  const defaults: ResultSummary = { applied: 0, not_applicable: 0, failed: 0, cost_jpy: 0 };
  if (!json || typeof json !== 'object') return defaults;
  const obj = json as Record<string, unknown>;
  return {
    applied: typeof obj.applied === 'number' ? obj.applied : 0,
    not_applicable: typeof obj.not_applicable === 'number' ? obj.not_applicable : 0,
    failed: typeof obj.failed === 'number' ? obj.failed : 0,
    cost_jpy: toNumber(obj.cost_jpy),
    blocked_books: Array.isArray(obj.blocked_books)
      ? obj.blocked_books.filter((x): x is string => typeof x === 'string')
      : undefined,
  };
}

function parseApplicationResult(json: unknown): ApplicationResult | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  return {
    reason: typeof obj.reason === 'string' ? obj.reason : undefined,
    new_target_id: typeof obj.new_target_id === 'string' ? obj.new_target_id : undefined,
    diff_summary: typeof obj.diff_summary === 'string' ? obj.diff_summary : undefined,
  };
}

function toNumber(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
