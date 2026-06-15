'use client';

/**
 * JobDetailShell — S-026 ジョブ詳細 2-column レイアウト (T-09-02).
 *
 * Left 70%: JobHeader / PayloadJsonViewer / LogStreamViewer / ErrorDetail
 * Right 30%: TokenUsageInline / JobMetaCard / ActionGroup
 *
 * Mobile: 1-column (stack); fixed-bottom action bar on mobile.
 * 仕様根拠: docs/wireframes/S-026-job-detail/prompt.md
 */
import type { JobDetailSerialized } from '@/lib/jobs-view';
import { JobHeader } from './job-header';
import { PayloadJsonViewer } from './payload-json-viewer';
import { LogStreamViewer } from './log-stream-viewer';
import { ErrorDetail } from './error-detail';
import { TokenUsageInline } from './token-usage-inline';
import { JobMetaCard } from './job-meta-card';
import { ActionGroup } from './action-group';

interface JobDetailShellProps {
  job: JobDetailSerialized;
}

export function JobDetailShell({ job }: JobDetailShellProps) {
  return (
    <div className="flex flex-col gap-space-normal">
      {/* Job header — full width */}
      <JobHeader
        id={job.id}
        kind={job.kind}
        status={job.status}
        book_id={job.book_id}
        book_title={job.book_title}
        started_at={job.started_at}
        finished_at={job.finished_at}
        elapsed_ms={job.elapsed_ms}
        retries={job.retries}
      />

      {/* 2-column grid: left 70% / right 30% — stacks on mobile */}
      <div className="flex flex-col gap-space-normal lg:flex-row">
        {/* Left column: logs + payload + error */}
        <div className="flex flex-col gap-space-normal lg:w-[70%]">
          <PayloadJsonViewer payload={job.payload_json} />
          <LogStreamViewer
            jobId={job.id}
            bookId={job.book_id}
            initialStatus={job.status}
            startedAt={job.started_at}
            finishedAt={job.finished_at}
          />
          <ErrorDetail
            status={job.status}
            error={job.error}
            screenshotUrl={null}
          />
        </div>

        {/* Right column: tokens + meta + actions */}
        <div className="flex flex-col gap-space-normal lg:w-[30%]">
          <TokenUsageInline
            tokenUsages={job.token_usages}
            totalInputTokens={job.total_input_tokens}
            totalOutputTokens={job.total_output_tokens}
            totalCostJpy={job.total_cost_jpy}
          />
          <JobMetaCard
            kind={job.kind}
            status={job.status}
            bookId={job.book_id}
            bookTitle={job.book_title}
            bookThumbnailR2Key={job.book_thumbnail_r2_key}
            payloadJson={job.payload_json}
          />
          {/* Desktop action group */}
          <div className="hidden lg:block">
            <ActionGroup
              jobId={job.id}
              status={job.status}
              kind={job.kind}
              bookId={job.book_id}
            />
          </div>
        </div>
      </div>

      {/* Mobile: fixed bottom action bar */}
      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border-warm bg-white p-3 lg:hidden">
        <div className="flex gap-2">
          <ActionGroup
            jobId={job.id}
            status={job.status}
            kind={job.kind}
            bookId={job.book_id}
          />
        </div>
      </div>
    </div>
  );
}
