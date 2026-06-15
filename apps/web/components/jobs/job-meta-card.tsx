'use client';

/**
 * JobMetaCard — ジョブメタ情報カード (S-026, T-09-02).
 *
 * 親書籍 / バッチ ID / ワーカー / リトライ可能 / ステップ再開対応 の表示。
 * 仕様根拠: docs/wireframes/S-026-job-detail/prompt.md §Section 7
 */
import Link from 'next/link';

import { messages } from '@/lib/messages';

const m = messages.jobs.detail;

interface JobMetaCardProps {
  kind: string;
  status: string;
  bookId: string | null;
  bookTitle: string | null;
  bookThumbnailR2Key: string | null;
  payloadJson: unknown;
}

function extractBatchId(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>;
    return typeof p.batch_id === 'string' ? p.batch_id : null;
  }
  return null;
}

function extractWorker(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>;
    return typeof p.worker_id === 'string' ? p.worker_id : null;
  }
  return null;
}

const RETRIABLE_STATUSES = new Set(['failed']);
const STEP_RESUMABLE_KINDS = new Set([
  'pipeline.book.writer.outline',
  'pipeline.book.writer.chapters.dispatch',
  'pipeline.book.writer.chapter',
  'pipeline.book.editor',
  'pipeline.book.thumbnail.text',
  'pipeline.book.thumbnail.image',
  'pipeline.book.judge',
  'pipeline.book.export',
]);

export function JobMetaCard({
  kind,
  status,
  bookId,
  bookTitle,
  bookThumbnailR2Key,
  payloadJson,
}: JobMetaCardProps) {
  const batchId = extractBatchId(payloadJson);
  const worker = extractWorker(payloadJson);
  const isRetriable = RETRIABLE_STATUSES.has(status);
  const isStepResumable = STEP_RESUMABLE_KINDS.has(kind);

  return (
    <section
      aria-label={m.metaSection}
      className="rounded-card border border-border-warm bg-white p-space-normal"
    >
      <h2 className="text-body font-medium text-foreground">{m.metaSection}</h2>

      <dl className="mt-space-snug flex flex-col gap-space-snug">
        {bookId && (
          <div className="flex items-start gap-3">
            {/* Thumbnail placeholder */}
            <div className="h-12 w-10 shrink-0 rounded border border-border-warm bg-cream-light">
              {bookThumbnailR2Key ? (
                <div className="flex h-full w-full items-center justify-center">
                  <span className="text-caption text-muted">IMG</span>
                </div>
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <span className="text-caption text-muted">—</span>
                </div>
              )}
            </div>
            <div className="min-w-0">
              <dt className="text-caption text-muted">{m.parentBook}</dt>
              <dd className="mt-0.5 text-body">
                <Link
                  href={`/books/${bookId}`}
                  className="text-accent no-underline hover:underline break-all"
                >
                  {bookTitle ?? bookId.slice(0, 12)}
                </Link>
              </dd>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between">
          <dt className="text-caption text-muted">{m.batchId}</dt>
          <dd className="text-caption text-foreground">{batchId ?? m.noBatch}</dd>
        </div>

        <div className="flex items-center justify-between">
          <dt className="text-caption text-muted">{m.worker}</dt>
          <dd className="text-caption text-foreground">{worker ?? m.noWorker}</dd>
        </div>

        <div className="flex items-center justify-between">
          <dt className="text-caption text-muted">{m.retriable}</dt>
          <dd>
            <span
              className={`rounded px-1.5 py-0.5 text-caption font-medium ${isRetriable ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}
            >
              {isRetriable ? m.yes : m.no}
            </span>
          </dd>
        </div>

        <div className="flex items-center justify-between">
          <dt className="text-caption text-muted">{m.stepResumable}</dt>
          <dd>
            <span
              className={`rounded px-1.5 py-0.5 text-caption font-medium ${isStepResumable ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}
            >
              {isStepResumable ? m.yes : m.no}
            </span>
          </dd>
        </div>
      </dl>
    </section>
  );
}
