'use client';

/**
 * S-011 ページ本体 (T-04-08).
 *
 * themes-page-shell.tsx と同型: selection state を持つ Client コンポーネント。
 * page.tsx (RSC) から行データだけ受け取り、カードグリッド + BulkActionBar を統括する。
 *
 * - pending_review 行のみ選択可能 (page.tsx 側で既に絞り込み済み)
 * - bulk SA 成功後は selection をクリアし router.refresh() で再取得
 */
import { useCallback, useMemo, useState } from 'react';

import { pickEligibleIds, type OutlineRowSerialized, type OutlineCommentSerialized } from '@/lib/outlines-view';

import { OutlineBulkActionBar } from './outline-bulk-action-bar';
import { OutlineCardsGrid } from './outline-cards-grid';

interface OutlinesPageShellProps {
  rows: readonly OutlineRowSerialized[];
  commentsMap?: Record<string, OutlineCommentSerialized[]>;
}

export function OutlinesPageShell({ rows, commentsMap = {} }: OutlinesPageShellProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const onToggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onToggleAll = useCallback(
    (selectAll: boolean) => {
      setSelected(() => {
        if (!selectAll) return new Set();
        const next = new Set<string>();
        for (const r of rows) {
          if (r.status === 'pending_review') next.add(r.id);
        }
        return next;
      });
    },
    [rows],
  );

  const onClear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const eligibleIds = useMemo(() => pickEligibleIds(rows, selected), [rows, selected]);

  return (
    <div className="flex flex-col gap-space-snug">
      <OutlineCardsGrid
        rows={rows}
        selectedIds={selected}
        onToggle={onToggle}
        onToggleAll={onToggleAll}
        commentsMap={commentsMap}
      />
      {eligibleIds.length > 0 && (
        <OutlineBulkActionBar
          selectedIds={eligibleIds}
          onSelectionClear={onClear}
        />
      )}
    </div>
  );
}
