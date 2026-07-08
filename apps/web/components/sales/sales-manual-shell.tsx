'use client';

/**
 * SalesManualShell — S-018 売上手動入力 クライアントシェル (T-08-06).
 *
 * 書籍選択・年月選択の状態を保持し、子コンポーネント
 * (SalesInputForm / SalesHistoryTable / CsvImportPanel) に委譲する。
 *
 * 仕様根拠: docs/04 S-018 / SP-08 T-08-06
 */
import { useState, useEffect, useCallback } from 'react';

import { messages } from '@/lib/messages';
import type { BookSelectorItem, SalesHistoryData, SalesHistoryRow } from '@/lib/sales-view';

import { SalesInputForm } from './sales-input-form';
import { SalesHistoryTable } from './sales-history-table';
import { CsvImportPanel } from './csv-import-panel';
import { KdpReportImportPanel } from './kdp-report-import-panel';
import { BookSelector } from './book-selector';
import { YearMonthSelector } from './year-month-selector';

interface SalesManualShellProps {
  books: BookSelectorItem[];
}

const m = messages.salesManual;

export function SalesManualShell({ books }: SalesManualShellProps) {
  const [selectedBookId, setSelectedBookId] = useState<string>('');
  const [selectedYearMonth, setSelectedYearMonth] = useState<string>('');

  /** Prefill data when existing record is found. null = no existing, undefined = loading */
  const [prefill, setPrefill] = useState<{
    royalty_jpy: number;
    review_count: number;
    avg_stars: number | null;
    bsr: number | null;
  } | null | undefined>(undefined);

  const [history, setHistory] = useState<SalesHistoryData | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const selectedBook = books.find((b) => b.id === selectedBookId) ?? null;

  // Fetch existing record for prefill and history whenever book+month changes
  useEffect(() => {
    if (!selectedBookId || !selectedYearMonth) {
      setPrefill(undefined);
      return;
    }

    let cancelled = false;

    async function fetchExisting() {
      setPrefill(undefined);
      try {
        const params = new URLSearchParams({
          book_id: selectedBookId,
          year_month: selectedYearMonth,
        });
        const res = await fetch(`/api/sales/record?${params.toString()}`);
        if (!res.ok) {
          if (!cancelled) setPrefill(null);
          return;
        }
        const json = await res.json() as {
          data: {
            royalty_jpy: number;
            review_count: number;
            avg_stars: number | null;
            bsr: number | null;
          } | null;
        };
        if (!cancelled) setPrefill(json.data ?? null);
      } catch {
        if (!cancelled) setPrefill(null);
      }
    }

    void fetchExisting();
    return () => { cancelled = true; };
  }, [selectedBookId, selectedYearMonth]);

  // Fetch history when book changes
  useEffect(() => {
    if (!selectedBookId) {
      setHistory(null);
      return;
    }

    let cancelled = false;

    async function fetchHistory() {
      setHistoryLoading(true);
      try {
        const res = await fetch(`/api/sales/history?book_id=${encodeURIComponent(selectedBookId)}`);
        if (!res.ok || cancelled) return;
        const json = await res.json() as { data: { book_title: string; rows: SalesHistoryRow[] } };
        if (!cancelled) {
          setHistory({
            book_id: selectedBookId,
            book_title: json.data.book_title,
            rows: json.data.rows,
          });
        }
      } catch {
        // silently fail
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    }

    void fetchHistory();
    return () => { cancelled = true; };
  }, [selectedBookId]);

  const handleSaveSuccess = useCallback(() => {
    // Re-fetch history after save
    setSelectedYearMonth((prev) => {
      // trigger re-render to refresh prefill check; keep same value
      return prev;
    });
    // Refresh history
    if (selectedBookId) {
      setHistory(null);
      setHistoryLoading(true);
      fetch(`/api/sales/history?book_id=${encodeURIComponent(selectedBookId)}`)
        .then((r) => r.json())
        .then((json: { data: { book_title: string; rows: SalesHistoryRow[] } }) => {
          setHistory({
            book_id: selectedBookId,
            book_title: json.data.book_title,
            rows: json.data.rows,
          });
        })
        .catch(() => {})
        .finally(() => setHistoryLoading(false));
    }
  }, [selectedBookId]);

  const isUpsertMode =
    prefill !== undefined && prefill !== null && selectedBookId !== '' && selectedYearMonth !== '';

  return (
    <div className="flex flex-col gap-space-loose lg:flex-row lg:items-start">
      {/* Left column: selector + form + history */}
      <div className="flex min-w-0 flex-1 flex-col gap-space-loose lg:max-w-[60%]">
        {/* Input target selector */}
        <section
          className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-surface p-4"
          aria-labelledby="selector-heading"
          data-testid="input-target-selector"
        >
          <h2 id="selector-heading" className="text-label text-foreground">
            {m.selector.sectionTitle}
          </h2>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <BookSelector
                books={books}
                value={selectedBookId}
                onChange={setSelectedBookId}
              />
            </div>
            <div className="w-full sm:w-48">
              <YearMonthSelector
                value={selectedYearMonth}
                onChange={setSelectedYearMonth}
              />
            </div>
          </div>
          {isUpsertMode && (
            <p className="text-body-sm text-muted" role="status" aria-live="polite">
              {m.selector.upsertNote}
            </p>
          )}
        </section>

        {/* Sales input form */}
        <SalesInputForm
          bookId={selectedBookId}
          yearMonth={selectedYearMonth}
          prefill={prefill ?? null}
          isUpsertMode={isUpsertMode}
          onSaveSuccess={handleSaveSuccess}
        />

        {/* History summary */}
        {selectedBook && (
          <SalesHistoryTable
            history={history}
            bookTitle={selectedBook.title}
            isLoading={historyLoading}
          />
        )}
      </div>

      {/* Right column: KDP xlsx import + CSV import */}
      <div className="flex w-full flex-col gap-space-loose lg:w-[40%] lg:shrink-0">
        <KdpReportImportPanel />
        <CsvImportPanel />
      </div>
    </div>
  );
}
