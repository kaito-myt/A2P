'use client';

/**
 * S-006 BulkActionBar (T-03-07 / F-017).
 *
 * - 「採用」: `acceptThemesAndCreateBatch` SA を起動 = 採用 + 夜間バッチ計画を
 *   自動作成 → `/batches` へ遷移。従来の「採用のみ」ボタンは廃止し、採用したら
 *   必ずバッチに乗る 1 本道にする (accepted のまま放置される事故を防ぐ)。
 * - 「却下」: `bulkDecideThemes` SA を起動 (pending のみ対象)
 * - 「選択解除」: 親 (themes-page-shell) の selection を空にする
 *
 * 進行中 (useTransition) の間はボタン全部 disabled。
 */
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import {
  acceptThemesAndCreateBatch,
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
  const canReject = selectedPendingIds.length > 0;
  // 「採用」は accepted も混ぜてバッチ投入できるので selectedIds で判定。
  const canAccept = selectedIds.length > 0;

  // 「採用」= 採用 + 夜間バッチ計画を自動作成 → /batches へ遷移 (1 本道)。
  function accept() {
    setError(null);
    setInfo(null);
    if (!canAccept) {
      setError(m.errors.bulkValidation);
      return;
    }
    startTransition(async () => {
      const result = await acceptThemesAndCreateBatch({ theme_ids: selectedIds });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      // 成功トーストは遷移先で消えるが、体感のため一瞬表示してから push。
      setInfo(m.bulkSuccess.acceptBatch(result.data.item_count));
      onSelectionClear();
      router.push(result.data.redirect_to);
    });
  }

  function reject() {
    setError(null);
    setInfo(null);
    if (!canReject) {
      setError(m.errors.noPending);
      return;
    }
    startTransition(async () => {
      const result = await bulkDecideThemes({
        theme_ids: selectedPendingIds,
        decision: 'reject',
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setInfo(m.bulkSuccess.reject(result.data.updated));
      onSelectionClear();
      router.refresh();
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
          disabled={pending || !canAccept}
          onClick={accept}
          data-testid="bulk-accept-button"
        >
          {m.bulk.accept}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={pending || !canReject}
          onClick={reject}
          data-testid="bulk-reject-button"
        >
          {m.bulk.reject}
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
