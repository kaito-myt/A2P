'use client';

/**
 * S-010 ジョブ履歴タブ (T-04-09).
 *
 * この書籍に紐づく Job 一覧をテーブル表示。
 * 各行から S-026 (ジョブ詳細) へのリンクは将来対応。
 */
import { Badge } from '@/components/ui/badge';
import { messages } from '@/lib/messages';
import type { BookJobSerialized, JobStatus } from '@/lib/books-view';
import { formatDateTime, formatJobKind } from '@/lib/books-view';

const m = messages.books.jobHistory;
const mStatus = messages.books.jobStatus;

function jobStatusVariant(status: JobStatus): 'success' | 'must' | 'should' | 'neutral' {
  switch (status) {
    case 'done':
      return 'success';
    case 'failed':
      return 'must';
    case 'running':
      return 'should';
    default:
      return 'neutral';
  }
}

function jobStatusLabel(status: JobStatus): string {
  return mStatus[status] ?? status;
}

interface JobHistoryTabProps {
  jobs: BookJobSerialized[];
}

export function JobHistoryTab({ jobs }: JobHistoryTabProps) {
  if (jobs.length === 0) {
    return (
      <div
        className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        data-testid="job-history-tab-empty"
      >
        <p className="text-body text-muted">{m.noJobs}</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto" data-testid="job-history-tab">
      <table className="w-full text-body">
        <thead>
          <tr className="border-b border-border-warm text-left text-caption text-muted">
            <th className="px-2 py-1.5">{m.colKind}</th>
            <th className="px-2 py-1.5">{m.colStatus}</th>
            <th className="px-2 py-1.5">{m.colStartedAt}</th>
            <th className="px-2 py-1.5">{m.colFinishedAt}</th>
            <th className="px-2 py-1.5">{m.colRetries}</th>
            <th className="px-2 py-1.5">{m.colError}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr
              key={job.id}
              className="border-b border-border-warm last:border-b-0"
              data-testid={`job-row-${job.id}`}
            >
              <td className="px-2 py-1.5">{formatJobKind(job.kind)}</td>
              <td className="px-2 py-1.5">
                <Badge variant={jobStatusVariant(job.status)}>
                  {jobStatusLabel(job.status)}
                </Badge>
              </td>
              <td className="px-2 py-1.5">
                {job.started_at ? formatDateTime(job.started_at) : m.noDate}
              </td>
              <td className="px-2 py-1.5">
                {job.finished_at ? formatDateTime(job.finished_at) : m.noDate}
              </td>
              <td className="px-2 py-1.5">{job.retries}</td>
              <td className="px-2 py-1.5 max-w-xs truncate" title={job.error ?? undefined}>
                {job.error ?? m.noError}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
