'use client';

/**
 * S-025 JobsPageShell (T-09-01, F-045/F-046).
 *
 * Client shell: フィルタバー + 統計カード + ジョブテーブル + BulkActionBar。
 * RSC page から props 注入。
 *
 * 仕様根拠: docs/04 S-025 / SP-09 T-09-01
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

import { messages } from '@/lib/messages';
import { type JobRowSerialized, type JobStats } from '@/lib/jobs-view';

import { JobsFilterBar } from './jobs-filter-bar';
import { JobStatsCards } from './job-stats-card';
import { JobsTable } from './jobs-table';
import { BulkActionBar } from './bulk-action-bar';

interface BookOption {
  id: string;
  title: string;
}

interface JobsPageShellProps {
  rows: JobRowSerialized[];
  stats: JobStats;
  books: BookOption[];
  totalCount: number;
  currentKind: string;
  currentStatus: string;
  currentPeriod: string;
  currentBookId: string;
}

const m = messages.jobs;

export function JobsPageShell({
  rows,
  stats,
  books,
  totalCount,
  currentKind,
  currentStatus,
  currentPeriod,
  currentBookId,
}: JobsPageShellProps) {
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [currentPage, setCurrentPage] = useState(0);

  const handleRetried = useCallback(() => {
    router.refresh();
  }, [router]);

  const handleClear = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(Math.max(0, page));
  }, []);

  return (
    <div
      className="flex flex-col gap-space-loose pb-24"
      data-testid="jobs-page-shell"
    >
      {/* Count */}
      <p className="text-body text-muted">{m.totalCount(totalCount)}</p>

      {/* Stats */}
      <JobStatsCards stats={stats} />

      {/* Filter */}
      <JobsFilterBar
        books={books}
        currentKind={currentKind}
        currentStatus={currentStatus}
        currentPeriod={currentPeriod}
        currentBookId={currentBookId}
      />

      {/* Table */}
      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <JobsTable
          rows={rows}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          currentPage={currentPage}
          onPageChange={handlePageChange}
        />
      )}

      {/* Bulk */}
      <BulkActionBar
        selectedIds={selectedIds}
        onClear={handleClear}
        onRetried={handleRetried}
      />
    </div>
  );
}

function EmptyState() {
  const m = messages.jobs.empty;
  return (
    <div
      className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
      data-testid="jobs-empty-state"
    >
      <p className="text-body font-medium text-charcoal">{m.title}</p>
      <p className="mt-2 text-body text-muted">{m.body}</p>
      <div className="mt-space-snug flex justify-center">
        <a
          href="/batches/new"
          className="text-button-sm text-foreground underline hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="jobs-empty-cta"
        >
          {m.cta}
        </a>
      </div>
    </div>
  );
}
