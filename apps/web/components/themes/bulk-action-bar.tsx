'use client';

/**
 * S-006 BulkActionBar (T-03-07 / F-017).
 *
 * - 「採用」「却下」: `bulkDecideThemes` SA を起動 (pending のみ対象)
 * - 「採用してバッチ計画へ」: `acceptThemesAndStageBatch` SA を起動 → redirect
 * - 「選択解除」: 親 (themes-page-shell) の selection を空にする
 *
 * 進行中 (useTransition) の間はボタン全部 disabled。
 */
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import {
  acceptThemesAndStageBatch,
  bulkDecideThemes,
} from '@/app/actions/themes';
import { messages } from '@/lib/messages';

const m = messages.themes;

interface BulkActionBarProps {
  selectedIds: string[];
  selectedPendingIds: string[];
  onSelectionClear: () => void;
}

export function BulkActionBar({
  selectedIds,
  selectedPendingIds,
  onSelectionClear,
}: BulkActionBarProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const selectionCount = selectedIds.length;
  // selectedIds === 0 のときは bar 自体を表示しない (parent 側で制御)。
  const canDecide = selectedPendingIds.length > 0;
  // 「採用してバッチ計画へ」は accepted も混ぜて転送可能なので selectedIds で判定。
  const canStage = selectedIds.length > 0;

  function decide(decision: 'accept' | 'reject') {
    setError(null);
    setInfo(null);
    if (!canDecide) {
      setError(m.errors.noPending);
      return;
    }
    startTransition(async () => {
      const result = await bulkDecideThemes({
        theme_ids: selectedPendingIds,
        decision,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      const n = result.data.updated;
      setInfo(
        decision === 'accept' ? m.bulkSuccess.accept(n) : m.bulkSuccess.reject(n),
      );
      onSelectionClear();
      router.refresh();
    });
  }

  function stageBatch() {
    setError(null);
    setInfo(null);
    if (!canStage) {
      setError(m.errors.bulkValidation);
      return;
    }
    startTransition(async () => {
      const result = await acceptThemesAndStageBatch({ theme_ids: selectedIds });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      router.push(result.data.redirect_to);
    });
  }

  return (
    <div
      data-testid="bulk-action-bar"
      className="sticky bottom-0 z-10 flex flex-wrap items-center gap-space-snug border-t-2 border-charcoal bg-cream-light px-space-relaxed py-space-snug shadow-l2-inset"
    >
      <span
        data-testid="bulk-selection-count"
        className="text-button font-medium text-charcoal"
      >
        {m.bulk.selectionCount(selectionCount)}
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-space-snug">
        {error && (
          <span data-testid="bulk-error" className="text-button-sm text-destructive">
            {error}
          </span>
        )}
        {info && (
          <span data-testid="bulk-info" className="text-button-sm text-success">
            {info}
          </span>
        )}
        <Button
          type="button"
          variant="default"
          disabled={pending || !canDecide}
          onClick={() => decide('accept')}
          data-testid="bulk-accept-button"
        >
          {m.bulk.accept}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={pending || !canDecide}
          onClick={() => decide('reject')}
          data-testid="bulk-reject-button"
        >
          {m.bulk.reject}
        </Button>
        <Button
          type="button"
          variant="default"
          disabled={pending || !canStage}
          onClick={stageBatch}
          data-testid="bulk-stage-batch-button"
        >
          {m.bulk.stageBatch}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending || selectionCount === 0}
          onClick={onSelectionClear}
          data-testid="bulk-clear-button"
        >
          {m.bulk.clear}
        </Button>
      </div>
    </div>
  );
}
