'use client';

/**
 * S-017 BooksKpiTable (T-08-07, F-039).
 *
 * 書籍別 KPI テーブル: サムネ / タイトル / 出版日 / ASIN /
 *   月次売上 / 累計売上 / 順位 / ★ / Quality / 累計コスト / ROI.
 *
 * 100 冊規模: ページネーション方式 (50 件/ページ)。
 * ソート: クライアントサイドでコラムヘッダクリックにより切替。
 * aria-sort 設定済み。
 *
 * 仕様根拠: docs/04 S-017 / SP-08 T-08-07 / F-039 受け入れ基準 2 秒
 */

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';

import { messages } from '@/lib/messages';
import {
  formatJpy,
  formatStars,
  formatBsr,
  formatQuality,
  formatKenp,
  type BookKpiRowSerialized,
} from '@/lib/sales-kpi-view';

interface BooksKpiTableProps {
  books: BookKpiRowSerialized[];
}

const m = messages.salesKpi.table;
const PAGE_SIZE = 50;

type SortKey = keyof BookKpiRowSerialized;
type SortDir = 'asc' | 'desc' | 'none';

function nextDir(current: SortDir, clicked: boolean): SortDir {
  if (!clicked) return 'desc';
  if (current === 'desc') return 'asc';
  if (current === 'asc') return 'none';
  return 'desc';
}

export function BooksKpiTable({ books }: BooksKpiTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>('cumulative_royalty_jpy');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => {
    if (sortDir === 'none') return [...books];
    return [...books].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av;
      }
      const as = String(av);
      const bs = String(bv);
      return sortDir === 'asc' ? as.localeCompare(bs, 'ja') : bs.localeCompare(as, 'ja');
    });
  }, [books, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function handleSort(key: SortKey) {
    const isActive = sortKey === key;
    const next = nextDir(sortDir, isActive);
    setSortKey(key);
    setSortDir(next);
    setPage(1);
  }

  if (books.length === 0) {
    return (
      <div
        className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        data-testid="books-kpi-table-empty"
      >
        <p className="text-body text-muted">{m.empty}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-space-snug" data-testid="books-kpi-table">
      <div className="overflow-x-auto rounded-card border border-border-warm">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b border-border-warm bg-cream-light text-left">
              <Th label={m.colThumbnail} sortable={false} />
              <SortTh
                label={m.colTitle}
                colKey="title"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
              />
              <SortTh
                label={m.colPublishedAt}
                colKey="published_at"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
              />
              <Th label={m.colAsin} sortable={false} />
              <SortTh
                label={m.colMonthlyRoyalty}
                colKey="monthly_royalty_jpy"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
              />
              <SortTh
                label={m.colCumulativeRoyalty}
                colKey="cumulative_royalty_jpy"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
              />
              <SortTh
                label="KENP読了"
                colKey="cumulative_kenp_read"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
              />
              <SortTh
                label={m.colBsr}
                colKey="latest_bsr"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
              />
              <SortTh
                label={m.colAvgStars}
                colKey="avg_stars"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
              />
              <SortTh
                label={m.colQuality}
                colKey="quality_score"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
              />
              <SortTh
                label={m.colCostJpy}
                colKey="cost_jpy"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
              />
              <SortTh
                label={m.colRoi}
                colKey="roi"
                activeKey={sortKey}
                dir={sortDir}
                onSort={handleSort}
              />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((book) => (
              <tr
                key={book.book_id}
                className="border-b border-border-warm last:border-0 hover:bg-cream-light"
              >
                {/* Thumbnail */}
                <td className="w-12 px-space-relaxed py-space-snug">
                  {book.thumbnail_r2_key ? (
                    <div className="h-10 w-8 rounded-sm bg-charcoal-04 text-center text-caption text-muted leading-10">
                      {m.thumbnailAlt}
                    </div>
                  ) : (
                    <div className="h-10 w-8 rounded-sm bg-cream border border-border-warm" />
                  )}
                </td>

                {/* Title */}
                <td className="max-w-xs px-space-relaxed py-space-snug">
                  <Link
                    href={`/books/${book.book_id}`}
                    className="line-clamp-2 text-foreground underline hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    title={book.title}
                  >
                    {book.title}
                  </Link>
                  {book.subtitle && (
                    <p className="mt-0.5 line-clamp-1 text-caption text-muted" title={book.subtitle}>
                      {book.subtitle}
                    </p>
                  )}
                </td>

                {/* Published */}
                <td className="whitespace-nowrap px-space-relaxed py-space-snug text-muted">
                  {book.published_at
                    ? new Date(book.published_at).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })
                    : '—'}
                </td>

                {/* ASIN */}
                <td className="whitespace-nowrap px-space-relaxed py-space-snug font-mono text-caption text-muted">
                  {book.asin ?? '—'}
                </td>

                {/* Monthly royalty */}
                <td className="whitespace-nowrap px-space-relaxed py-space-snug text-right tabular-nums text-charcoal">
                  {formatJpy(book.monthly_royalty_jpy)}
                </td>

                {/* Cumulative royalty */}
                <td className="whitespace-nowrap px-space-relaxed py-space-snug text-right tabular-nums text-charcoal">
                  {formatJpy(book.cumulative_royalty_jpy)}
                </td>

                {/* KENP read (累計) — 月次があれば副表示 */}
                <td className="whitespace-nowrap px-space-relaxed py-space-snug text-right tabular-nums text-muted">
                  {formatKenp(book.cumulative_kenp_read)}
                  {book.monthly_kenp_read > 0 && (
                    <span className="ml-1 text-caption text-muted/70">
                      (今期 {formatKenp(book.monthly_kenp_read)})
                    </span>
                  )}
                </td>

                {/* BSR */}
                <td className="whitespace-nowrap px-space-relaxed py-space-snug text-right tabular-nums text-muted">
                  {formatBsr(book.latest_bsr)}
                </td>

                {/* Stars */}
                <td className="whitespace-nowrap px-space-relaxed py-space-snug text-right tabular-nums text-muted">
                  {formatStars(book.avg_stars)}
                </td>

                {/* Quality */}
                <td className="whitespace-nowrap px-space-relaxed py-space-snug text-right tabular-nums text-muted">
                  {formatQuality(book.quality_score)}
                </td>

                {/* Cost */}
                <td className="whitespace-nowrap px-space-relaxed py-space-snug text-right tabular-nums text-muted">
                  {formatJpy(book.cost_jpy)}
                </td>

                {/* ROI */}
                <td
                  className={`whitespace-nowrap px-space-relaxed py-space-snug text-right font-medium tabular-nums ${
                    book.roi != null && book.roi >= 1
                      ? 'text-green-700'
                      : book.roi != null && book.roi < 1
                        ? 'text-red-600'
                        : 'text-muted'
                  }`}
                >
                  {book.roi_display}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-button-sm text-muted">
          <span>
            {m.pagination(Math.min((page - 1) * PAGE_SIZE + 1, books.length), Math.min(page * PAGE_SIZE, books.length), books.length)}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="cursor-pointer rounded-card border border-border-warm px-2 py-1 hover:bg-cream-light disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              aria-label={m.prevPage}
            >
              {m.prevPage}
            </button>
            <button
              type="button"
              className="cursor-pointer rounded-card border border-border-warm px-2 py-1 hover:bg-cream-light disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              aria-label={m.nextPage}
            >
              {m.nextPage}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Th({ label, sortable }: { label: string; sortable: boolean }) {
  void sortable;
  return (
    <th className="px-space-relaxed py-space-snug font-medium text-charcoal whitespace-nowrap">
      {label}
    </th>
  );
}

function SortTh({
  label,
  colKey,
  activeKey,
  dir,
  onSort,
}: {
  label: string;
  colKey: SortKey;
  activeKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const isActive = activeKey === colKey;
  const ariaSortValue: 'ascending' | 'descending' | 'none' = isActive && dir !== 'none'
    ? dir === 'asc' ? 'ascending' : 'descending'
    : 'none';

  return (
    <th
      className="px-space-relaxed py-space-snug font-medium text-charcoal whitespace-nowrap"
      aria-sort={ariaSortValue}
    >
      <button
        type="button"
        className="flex cursor-pointer items-center gap-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        onClick={() => onSort(colKey)}
      >
        {label}
        {isActive && dir === 'asc' ? (
          <ChevronUp className="h-3 w-3" />
        ) : isActive && dir === 'desc' ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-30" />
        )}
      </button>
    </th>
  );
}
