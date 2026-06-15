'use client';

/**
 * S-028 AlertsBulkActionBar (T-07-08).
 *
 * Actions: "選択を既読" / "選択を resolved" / "選択解除"
 * Calls markAlerts SA.
 */
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { markAlerts } from '@/app/actions/alerts';
import { Button } from '@/components/ui/button';
import { messages } from '@/lib/messages';

const m = messages.alerts;

interface AlertsBulkActionBarProps {
  selectedIds: string[];
  onSelectionClear: () => void;
}

export function AlertsBulkActionBar({
  selectedIds,
  onSelectionClear,
}: AlertsBulkActionBarProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const count = selectedIds.length;

  function handleMarkRead() {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const result = await markAlerts({
        alert_ids: selectedIds,
        action: 'mark_read',
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setInfo(m.markReadSuccess(result.data.updated));
      onSelectionClear();
      router.refresh();
    });
  }

  function handleMarkResolved() {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const result = await markAlerts({
        alert_ids: selectedIds,
        action: 'mark_resolved',
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setInfo(m.markResolvedSuccess(result.data.updated));
      onSelectionClear();
      router.refresh();
    });
  }

  return (
    <div
      data-testid="alerts-bulk-action-bar"
      className="sticky bottom-0 z-10 flex flex-wrap items-center gap-space-snug border-t-2 border-charcoal bg-cream-light px-space-relaxed py-space-snug shadow-l2-inset"
    >
      <span
        data-testid="alerts-bulk-selection-count"
        className="text-button font-medium text-charcoal"
      >
        {m.bulk.selectionCount(count)}
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-space-snug">
        {error && (
          <span
            data-testid="alerts-bulk-error"
            className="text-button-sm text-destructive"
          >
            {error}
          </span>
        )}
        {info && (
          <span
            data-testid="alerts-bulk-info"
            className="text-button-sm text-success"
          >
            {info}
          </span>
        )}
        <Button
          type="button"
          variant="default"
          disabled={pending || count === 0}
          onClick={handleMarkRead}
          data-testid="alerts-bulk-mark-read"
        >
          {m.bulk.markRead}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending || count === 0}
          onClick={handleMarkResolved}
          data-testid="alerts-bulk-mark-resolved"
        >
          {m.bulk.markResolved}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending || count === 0}
          onClick={onSelectionClear}
          data-testid="alerts-bulk-clear"
        >
          {m.bulk.clear}
        </Button>
      </div>
    </div>
  );
}
