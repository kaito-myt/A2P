'use client';

/**
 * S-025 JobsFilterBar (T-09-01, F-045).
 *
 * kind / status / period / book_id フィルタ (searchParams 駆動)。
 * SalesFilterBar と同パターン。
 *
 * 仕様根拠: docs/04 S-025 / SP-09 T-09-01
 */

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback, useTransition } from 'react';

import { messages } from '@/lib/messages';

interface BookOption {
  id: string;
  title: string;
}

interface JobsFilterBarProps {
  books: BookOption[];
  currentKind: string;
  currentStatus: string;
  currentPeriod: string;
  currentBookId: string;
}

const m = messages.jobs.filter;
const mKinds = messages.jobs.kindLabels;
const mStatus = messages.jobs.status;

const KIND_OPTIONS = [
  'pipeline.book.kickoff',
  'pipeline.book.marketer',
  'pipeline.book.writer.outline',
  'pipeline.book.writer.chapters.dispatch',
  'pipeline.book.writer.chapter',
  'pipeline.book.editor',
  'pipeline.book.thumbnail.text',
  'pipeline.book.thumbnail.image',
  'pipeline.book.judge',
  'pipeline.book.export',
  'revision.book.apply',
  'catalog.fetch',
  'fx.fetch',
] as const;

const STATUS_OPTIONS = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;

export function JobsFilterBar({
  books,
  currentKind,
  currentStatus,
  currentPeriod,
  currentBookId,
}: JobsFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const updateParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === '' || value === 'all') {
        params.delete(key);
      } else {
        params.set(key, value);
      }
      params.delete('page');
      startTransition(() => {
        router.push(`${pathname}?${params.toString()}`);
      });
    },
    [router, pathname, searchParams],
  );

  const selectClass =
    'cursor-pointer rounded-card border border-border-warm bg-white px-2 py-1 text-body text-charcoal focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50';

  return (
    <div
      className="flex flex-wrap items-center gap-space-snug rounded-card border border-border-warm bg-cream-light px-space-relaxed py-space-snug"
      data-testid="jobs-filter-bar"
    >
      {/* Kind */}
      <label className="flex items-center gap-1.5">
        <span className="whitespace-nowrap text-button-sm text-muted">{m.kindLabel}</span>
        <select
          className={selectClass}
          value={currentKind}
          disabled={isPending}
          onChange={(e) => updateParam('kind', e.target.value)}
          aria-label={m.kindLabel}
        >
          <option value="all">{m.kindAll}</option>
          {KIND_OPTIONS.map((k) => (
            <option key={k} value={k}>
              {mKinds[k] ?? k}
            </option>
          ))}
        </select>
      </label>

      {/* Status */}
      <label className="flex items-center gap-1.5">
        <span className="whitespace-nowrap text-button-sm text-muted">{m.statusLabel}</span>
        <select
          className={selectClass}
          value={currentStatus}
          disabled={isPending}
          onChange={(e) => updateParam('status', e.target.value)}
          aria-label={m.statusLabel}
        >
          <option value="all">{m.statusAll}</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {mStatus[s as keyof typeof mStatus] ?? s}
            </option>
          ))}
        </select>
      </label>

      {/* Period */}
      <label className="flex items-center gap-1.5">
        <span className="whitespace-nowrap text-button-sm text-muted">{m.periodLabel}</span>
        <select
          className={selectClass}
          value={currentPeriod}
          disabled={isPending}
          onChange={(e) => updateParam('period', e.target.value)}
          aria-label={m.periodLabel}
        >
          {m.periodOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      {/* Book */}
      <label className="flex items-center gap-1.5">
        <span className="whitespace-nowrap text-button-sm text-muted">{m.bookLabel}</span>
        <select
          className={selectClass}
          value={currentBookId}
          disabled={isPending}
          onChange={(e) => updateParam('bookId', e.target.value)}
          aria-label={m.bookLabel}
        >
          <option value="all">{m.bookAll}</option>
          {books.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
