'use client';

/**
 * S-006 ページ本体 (T-03-07).
 *
 * selection state を持つ Client コンポーネント。RSC (page.tsx) から行データだけ
 * 受け取り、テーブル + BulkActionBar を統括する。
 *
 * selection toggle 仕様:
 *  - pending 行のみ選択可能。pending 以外は checkbox disabled (table 側で制御)
 *  - 「全選択」は pending 行のみ対象
 *  - bulk SA 成功後は selection をクリアし router.refresh() で再取得
 */
import { useCallback, useMemo, useState } from 'react';

import { pickPendingIds, pickSelectedIds, type ThemeRowSerialized } from '@/lib/themes-view';

import { BulkActionBar } from './bulk-action-bar';
import { ThemeCandidatesTable } from './theme-candidates-table';

interface ThemesPageShellProps {
  rows: readonly ThemeRowSerialized[];
}

export function ThemesPageShell({ rows }: ThemesPageShellProps) {
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
          if (r.status === 'pending') next.add(r.id);
        }
        return next;
      });
    },
    [rows],
  );

  const onClear = useCallback(() => {
    setSelected(new Set());
  }, []);

  const selectedIds = useMemo(() => pickSelectedIds(rows, selected), [rows, selected]);
  const selectedPendingIds = useMemo(
    () => pickPendingIds(rows, selected),
    [rows, selected],
  );

  return (
    <div className="flex flex-col gap-space-snug">
      <ThemeCandidatesTable
        rows={rows}
        selectedIds={selected}
        onToggle={onToggle}
        onToggleAll={onToggleAll}
      />
      {selectedIds.length > 0 && (
        <BulkActionBar
          selectedIds={selectedIds}
          selectedPendingIds={selectedPendingIds}
          onSelectionClear={onClear}
        />
      )}
    </div>
  );
}
