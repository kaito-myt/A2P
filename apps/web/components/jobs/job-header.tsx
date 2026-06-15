'use client';

/**
 * JobHeader — S-026 ジョブヘッダー (T-09-02, F-045).
 *
 * 表示: ID / 種別 / 関連書籍リンク / ステータスバッジ / 開始・終了時刻 / 経過 / リトライ回数.
 * 仕様根拠: docs/wireframes/S-026-job-detail/prompt.md §Section 2
 */
import Link from 'next/link';

import { messages } from '@/lib/messages';
import { formatElapsedMs } from '@/lib/jobs-view';
import { JobStatusBadge } from './job-status-badge';

const m = messages.jobs.detail;
const mKinds = messages.jobs.kindLabels;

interface JobHeaderProps {
  id: string;
  kind: string;
  status: string;
  book_id: string | null;
  book_title: string | null;
  started_at: string | null;
  finished_at: string | null;
  elapsed_ms: number | null;
  retries: number;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

export function JobHeader({
  id,
  kind,
  status,
  book_id,
  book_title,
  started_at,
  finished_at,
  elapsed_ms,
  retries,
}: JobHeaderProps) {
  return (
    <section
      className="rounded-card border border-border-warm bg-white p-space-normal"
      aria-label="ジョブ基本情報"
    >
      {/* Failed banner */}
      {status === 'failed' && (
        <div
          role="alert"
          className="mb-space-snug flex items-center gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-body text-red-800"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>このジョブは失敗しました</span>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-x-space-normal gap-y-space-snug sm:grid-cols-3 lg:grid-cols-4">
        <div>
          <dt className="text-caption text-muted">{m.idLabel}</dt>
          <dd className="mt-0.5 font-mono text-caption text-foreground break-all">{id}</dd>
        </div>

        <div>
          <dt className="text-caption text-muted">{m.kindLabel}</dt>
          <dd className="mt-0.5 text-body text-foreground">
            {mKinds[kind] ?? kind}
          </dd>
        </div>

        <div>
          <dt className="text-caption text-muted">{m.bookLabel}</dt>
          <dd className="mt-0.5 text-body">
            {book_id ? (
              <Link
                href={`/books/${book_id}`}
                className="text-accent no-underline hover:underline"
              >
                {book_title ?? book_id.slice(0, 12)}
              </Link>
            ) : (
              <span className="text-muted">{m.noBook}</span>
            )}
          </dd>
        </div>

        <div>
          <dt className="text-caption text-muted">{m.statusLabel}</dt>
          <dd className="mt-0.5">
            <JobStatusBadge status={status} />
          </dd>
        </div>

        <div>
          <dt className="text-caption text-muted">{m.startedAtLabel}</dt>
          <dd className="mt-0.5 tabular-nums text-body text-foreground">
            {formatDateTime(started_at)}
          </dd>
        </div>

        <div>
          <dt className="text-caption text-muted">{m.finishedAtLabel}</dt>
          <dd className="mt-0.5 tabular-nums text-body text-foreground">
            {formatDateTime(finished_at)}
          </dd>
        </div>

        <div>
          <dt className="text-caption text-muted">{m.elapsedLabel}</dt>
          <dd className="mt-0.5 tabular-nums text-body text-foreground">
            {formatElapsedMs(elapsed_ms)}
          </dd>
        </div>

        <div>
          <dt className="text-caption text-muted">{m.retriesLabel}</dt>
          <dd className="mt-0.5 tabular-nums text-body text-foreground">{retries}</dd>
        </div>
      </dl>
    </section>
  );
}
