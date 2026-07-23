'use client';

/**
 * S-006 ページ本体 (T-03-07).
 *
 * selection state を持つ Client コンポーネント。RSC (page.tsx) から
 * 「全セッション横断のテーマ行」+「生成中セッション」を受け取り、
 * ステータス / ジャンル / 期間のフィルタ + テーブル + BulkActionBar を統括する。
 *
 * セッション別表示は廃止し、ステータスフィルタ (pending/accepted/rejected/all) で
 * 横断的に一覧する。過去に採用/却下したテーマもフィルタ切替で確認できる。
 *
 * selection toggle 仕様:
 *  - pending 行のみ選択可能。pending 以外は checkbox disabled (table 側で制御)
 *  - 「全選択」は現在の可視 pending 行のみ対象
 *  - bulk SA 成功後は selection をクリアし router.refresh() で再取得
 */
import { useCallback, useMemo, useState } from 'react';

import { genreLabel } from '@a2p/contracts';

import { messages } from '@/lib/messages';
import {
  pickPendingIds,
  pickSelectedIds,
  type GeneratingSession,
  type ThemeRowSerialized,
  type ThemeStatus,
} from '@/lib/themes-view';

import { BulkActionBar } from './bulk-action-bar';
import { GeneratingSessionsBanner } from './generating-sessions-banner';
import { ThemeCandidatesTable } from './theme-candidates-table';

interface ThemesPageShellProps {
  rows: readonly ThemeRowSerialized[];
  generatingSessions?: readonly GeneratingSession[];
}

type ThemeStatusFilter = ThemeStatus | 'all';
type PeriodFilter = 'all' | 'today' | 'd7' | 'd30';

const m = messages.themes;

const STATUS_FILTER_OPTIONS: { value: ThemeStatusFilter; label: string }[] = [
  { value: 'pending', label: '未採用' },
  { value: 'accepted', label: '採用済み' },
  { value: 'rejected', label: '却下' },
  { value: 'all', label: 'すべて' },
];

const PERIOD_FILTER_OPTIONS: { value: PeriodFilter; label: string }[] = [
  { value: 'all', label: m.filters.period.all },
  { value: 'today', label: m.filters.period.today },
  { value: 'd7', label: m.filters.period.d7 },
  { value: 'd30', label: m.filters.period.d30 },
];

/** 期間フィルタの下限 (ISO 文字列) を返す。all は null。 */
function periodCutoffIso(period: PeriodFilter): string | null {
  if (period === 'all') return null;
  const now = new Date();
  if (period === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return start.toISOString();
  }
  const days = period === 'd7' ? 7 : 30;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function ThemesPageShell({ rows, generatingSessions = [] }: ThemesPageShellProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  // 既定は「未採用」のみ表示。採用済み・却下はフィルタで切り替える。
  const [statusFilter, setStatusFilter] = useState<ThemeStatusFilter>('pending');
  const [genreFilter, setGenreFilter] = useState<string>('all');
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>('all');

  // 実データに存在するジャンルだけをフィルタ候補にする (ラベルで表示、slug で保持)。
  const genreOptions = useMemo(() => {
    const slugs = Array.from(new Set(rows.map((r) => r.genre))).filter(Boolean);
    return slugs
      .map((slug) => ({ slug, label: genreLabel(slug) ?? slug }))
      .sort((a, b) => a.label.localeCompare(b.label, 'ja'));
  }, [rows]);

  const visibleRows = useMemo(() => {
    const cutoff = periodCutoffIso(periodFilter);
    return rows.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (genreFilter !== 'all' && r.genre !== genreFilter) return false;
      if (cutoff && r.created_at < cutoff) return false;
      return true;
    });
  }, [rows, statusFilter, genreFilter, periodFilter]);

  const clearSelection = useCallback(() => setSelected(new Set()), []);

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
        for (const r of visibleRows) {
          if (r.status === 'pending') next.add(r.id);
        }
        return next;
      });
    },
    [visibleRows],
  );

  const selectedIds = useMemo(() => pickSelectedIds(rows, selected), [rows, selected]);
  const selectedPendingIds = useMemo(
    () => pickPendingIds(rows, selected),
    [rows, selected],
  );

  return (
    <div className="flex flex-col gap-space-snug">
      <GeneratingSessionsBanner sessions={generatingSessions} />

      <div
        className="flex flex-wrap items-end gap-x-space-relaxed gap-y-space-snug"
        data-testid="themes-filter-bar"
      >
        <FilterSelect
          id="themes-status-filter"
          label={m.filters.statusLabel}
          value={statusFilter}
          testId="themes-status-filter"
          onChange={(v) => {
            setStatusFilter(v as ThemeStatusFilter);
            clearSelection();
          }}
          options={STATUS_FILTER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
        <FilterSelect
          id="themes-genre-filter"
          label={m.filters.genreLabel}
          value={genreFilter}
          testId="themes-genre-filter"
          onChange={(v) => {
            setGenreFilter(v);
            clearSelection();
          }}
          options={[
            { value: 'all', label: m.filters.genreAll },
            ...genreOptions.map((g) => ({ value: g.slug, label: g.label })),
          ]}
        />
        <FilterSelect
          id="themes-period-filter"
          label={m.filters.periodLabel}
          value={periodFilter}
          testId="themes-period-filter"
          onChange={(v) => {
            setPeriodFilter(v as PeriodFilter);
            clearSelection();
          }}
          options={PERIOD_FILTER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
        <span className="pb-1.5 text-caption text-muted">
          {m.filters.count(visibleRows.length)}
        </span>
      </div>

      <ThemeCandidatesTable
        rows={visibleRows}
        selectedIds={selected}
        onToggle={onToggle}
        onToggleAll={onToggleAll}
      />
      {selectedIds.length > 0 && (
        <BulkActionBar
          selectedIds={selectedIds}
          selectedPendingIds={selectedPendingIds}
          onSelectionClear={clearSelection}
        />
      )}
    </div>
  );
}

interface FilterSelectProps {
  id: string;
  label: string;
  value: string;
  testId: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}

function FilterSelect({ id, label, value, testId, onChange, options }: FilterSelectProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-caption text-muted">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        className="rounded-default border border-border-warm bg-cream-light px-3 py-1.5 text-button-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
