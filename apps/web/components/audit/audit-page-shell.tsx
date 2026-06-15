'use client';

/**
 * S-029 AuditPageShell (T-09-03, F-029/F-030/F-046).
 *
 * Client shell: フィルタバー + 監査ログテーブル (+ JsonDiffExpander)。
 * RSC page から props 注入。読み取り専用 — 変更 SA なし。
 *
 * 仕様根拠: docs/04 S-029 / SP-09 T-09-03
 */

import { useState, useCallback } from 'react';

import { messages } from '@/lib/messages';
import { type AuditLogSerialized } from '@/lib/audit-view';

import { AuditFilterBar } from './audit-filter-bar';
import { AuditLogTable } from './audit-log-table';

interface AuditPageShellProps {
  rows: AuditLogSerialized[];
  totalCount: number;
  distinctActions: string[];
  distinctTargetKinds: string[];
  currentActor: string;
  currentAction: string;
  currentTargetKind: string;
  currentPeriod: string;
  currentSearch: string;
}

const PAGE_SIZE = 20;
const m = messages.audit;

export function AuditPageShell({
  rows,
  totalCount,
  distinctActions,
  distinctTargetKinds,
  currentActor,
  currentAction,
  currentTargetKind,
  currentPeriod,
  currentSearch,
}: AuditPageShellProps) {
  const [currentPage, setCurrentPage] = useState(0);

  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(Math.max(0, page));
  }, []);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages - 1);
  const pageRows = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <div className="flex flex-col gap-space-loose pb-24" data-testid="audit-page-shell">
      {/* Count */}
      <p className="text-body text-muted">{m.totalCount(rows.length, totalCount)}</p>

      {/* Filter */}
      <AuditFilterBar
        distinctActions={distinctActions}
        distinctTargetKinds={distinctTargetKinds}
        currentActor={currentActor}
        currentAction={currentAction}
        currentTargetKind={currentTargetKind}
        currentPeriod={currentPeriod}
        currentSearch={currentSearch}
      />

      {/* Table or empty state */}
      {rows.length === 0 ? (
        <AuditEmptyState />
      ) : (
        <AuditLogTable
          rows={pageRows}
          currentPage={safePage}
          totalRows={rows.length}
          pageSize={PAGE_SIZE}
          onPageChange={handlePageChange}
        />
      )}
    </div>
  );
}

function AuditEmptyState() {
  const em = messages.audit.empty;
  return (
    <div
      className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
      data-testid="audit-empty-state"
    >
      <p className="text-body font-medium text-charcoal">{em.title}</p>
      <p className="mt-2 text-body text-muted">{em.body}</p>
    </div>
  );
}
