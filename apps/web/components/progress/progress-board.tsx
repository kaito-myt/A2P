'use client';

/**
 * ProgressBoard (F-054) — 進行中パイプラインの進捗表示 + 8秒ごと自動更新。
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { messages } from '@/lib/messages';
import { cn } from '@/lib/cn';
import { PIPELINE_PHASES, type BookProgress, type ThemeGenerating } from '@/lib/progress-view';

const m = messages.progress;

export function ProgressBoard({
  books,
  themes,
}: {
  books: BookProgress[];
  themes: ThemeGenerating[];
}) {
  const router = useRouter();
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => router.refresh(), 8000);
    return () => clearInterval(t);
  }, [auto, router]);

  const nothing = books.length === 0 && themes.length === 0;

  return (
    <div className="flex flex-col gap-space-loose" data-testid="progress-page">
      <header className="flex flex-wrap items-start justify-between gap-space-snug">
        <div className="flex flex-col">
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
        <div className="flex items-center gap-space-snug">
          <label className="flex items-center gap-2 text-button-sm text-charcoal-82">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            {m.autoRefresh}
          </label>
          <button
            type="button"
            onClick={() => router.refresh()}
            className="rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04"
          >
            {m.refresh}
          </button>
        </div>
      </header>

      {nothing && (
        <div className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center">
          <p className="text-body text-muted">{m.empty}</p>
        </div>
      )}

      {themes.length > 0 && (
        <section className="flex flex-col gap-space-snug">
          <h2 className="text-card-title font-medium text-charcoal">{m.themesTitle}</h2>
          {themes.map((t) => (
            <div
              key={t.sessionId || Math.random()}
              className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-border-warm bg-cream-light p-space-relaxed"
            >
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden />
                <span className="text-body text-charcoal">
                  {m.themeRunning}
                  {t.accountName ? `（${t.accountName}）` : ''}
                </span>
              </div>
              <span className="text-caption text-muted">{m.elapsed(t.startedMinutes)}</span>
            </div>
          ))}
        </section>
      )}

      {books.length > 0 && (
        <section className="flex flex-col gap-space-snug">
          <h2 className="text-card-title font-medium text-charcoal">{m.booksTitle}</h2>
          {books.map((b) => (
            <BookProgressCard key={b.id} book={b} />
          ))}
        </section>
      )}
    </div>
  );
}

function BookProgressCard({ book }: { book: BookProgress }) {
  return (
    <div
      className={cn(
        'flex flex-col gap-space-snug rounded-card border p-space-relaxed',
        book.stalled ? 'border-warning bg-warning-bg/40' : 'border-border-warm bg-cream-light',
      )}
      data-testid={`progress-book-${book.id}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={`/books/${book.id}`} className="min-w-0 truncate text-card-title font-medium text-charcoal no-underline hover:text-accent">
          {book.title}
        </Link>
        <div className="flex items-center gap-2">
          <span className="rounded-pill bg-accent-bg px-2.5 py-0.5 text-caption font-medium text-accent">
            {book.phaseLabel}
          </span>
          <span className="text-button-sm font-medium text-charcoal">{book.percent}%</span>
        </div>
      </div>

      {/* フェーズ ステッパー */}
      <div className="flex items-center gap-1">
        {PIPELINE_PHASES.map((p, i) => (
          <div
            key={p.key}
            title={p.label}
            className={cn(
              'h-1.5 flex-1 rounded-pill',
              i < book.phaseIndex
                ? 'bg-success'
                : i === book.phaseIndex
                  ? 'bg-accent'
                  : 'bg-charcoal-04',
            )}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-space-relaxed gap-y-1 text-caption text-muted">
        {book.status === 'running' && book.chaptersTotal != null && (
          <span>{m.chapters(book.chaptersDone, book.chaptersTotal)}</span>
        )}
        <span>{m.idle(book.idleMinutes)}</span>
      </div>

      {book.stalled && (
        <div className="flex flex-col gap-1 rounded-card border border-warning/40 bg-cream-light p-space-snug">
          <span className="text-button-sm font-medium text-warning">{m.stalled}</span>
          <span className="text-caption text-charcoal-82">{book.stalledReason}</span>
          <Link href="/jobs" className="text-caption text-accent underline underline-offset-2">
            {m.retryHint}
          </Link>
        </div>
      )}
    </div>
  );
}
