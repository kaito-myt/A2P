'use client';

/**
 * S-010 書籍詳細 Client Shell (T-04-09).
 *
 * BookHeader + TabbedContent を統括する Client Component。
 * page.tsx (RSC) からシリアライズ済み BookDetailSerialized を受け取る。
 *
 * タブ構成:
 *   アウトライン / 章本文 / カバー / メタデータ / 評価履歴 / コスト内訳 / ジョブ履歴 / コメント
 *
 * SP-05/SP-06/SP-10 で実装予定のタブは placeholder 表示。
 */
import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { messages } from '@/lib/messages';
import {
  COST_THRESHOLD_PAUSE,
  COST_THRESHOLD_WARN,
  costThresholdPercent,
  formatBookStatus,
  formatCostStatus,
  formatGenre,
  type BookDetailSerialized,
  type BookStatus,
  type CostStatus,
} from '@/lib/books-view';
import type { CostBreakdownSummary } from '@/lib/cost-view';

import { OutlineTab } from './outline-tab';
import { ChaptersTab } from './chapters-tab';
import { ContentApprovalBanner } from './content-approval-banner';
import { CoverTab } from './cover-tab';
import { CostTab } from './cost-tab';
import { JobHistoryTab } from './job-history-tab';
import { EvaluationHistoryTable } from './evaluation-history-table';
import type { EvalResultSerialized } from '@/lib/eval-history-view';

const m = messages.books;

// ---------------------------------------------------------------------------
// Status → Badge variant mapping
// ---------------------------------------------------------------------------

function bookStatusVariant(status: BookStatus): 'success' | 'must' | 'should' | 'neutral' {
  switch (status) {
    case 'done':
      return 'success';
    case 'failed':
      return 'must';
    case 'needs_human_review':
    case 'paused_cost':
      return 'should';
    default:
      return 'neutral';
  }
}

function costStatusVariant(status: CostStatus): 'success' | 'must' | 'should' | 'neutral' {
  switch (status) {
    case 'normal':
      return 'success';
    case 'exceeded':
    case 'paused':
      return 'must';
    case 'warn':
      return 'should';
    default:
      return 'neutral';
  }
}

// ---------------------------------------------------------------------------
// BookHeader
// ---------------------------------------------------------------------------

function BookHeader({ book }: { book: BookDetailSerialized }) {
  const genreLabel = formatGenre(book.genre);
  const warnPct = costThresholdPercent(book.cost_jpy_total, COST_THRESHOLD_WARN);
  const pausePct = costThresholdPercent(book.cost_jpy_total, COST_THRESHOLD_PAUSE);

  return (
    <div data-testid="book-header" className="flex flex-col gap-space-snug">
      <div className="flex flex-wrap items-start justify-between gap-space-snug">
        <div className="flex flex-col gap-1">
          <h1 className="text-sub-heading text-foreground">{book.title}</h1>
          {book.subtitle && (
            <p className="text-body text-muted">{book.subtitle}</p>
          )}
        </div>
        <a
          href={`/api/books/${book.id}/bundle`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-card border border-border-warm bg-charcoal px-3 py-1.5 text-button-sm text-cream-light no-underline hover:opacity-80"
          data-testid="book-bundle-download"
        >
          {m.header.bundleDownload}
        </a>
      </div>

      <div
        className="flex flex-wrap items-center gap-x-space-relaxed gap-y-1 text-button-sm text-charcoal-82"
        data-testid="book-header-meta"
      >
        <span>
          {m.header.accountLabel}: {book.account.pen_name}
        </span>
        {genreLabel && (
          <span>
            {m.header.genreLabel}: {genreLabel}
          </span>
        )}
        <Badge variant={bookStatusVariant(book.status)} data-testid="book-status-badge">
          {formatBookStatus(book.status)}
        </Badge>
        <span>
          {m.header.qualityLabel}: {m.header.qualityPlaceholder}
        </span>
        <span>
          {m.header.asinLabel}: {book.asin ?? m.header.asinPlaceholder}
        </span>
      </div>

      <div
        className="flex flex-col gap-1"
        data-testid="book-cost-bar"
      >
        <div className="flex items-baseline gap-2 text-button-sm">
          <span className="font-medium">
            {m.header.costLabel}: {Math.round(book.cost_jpy_total).toLocaleString('ja-JP')} {m.header.costUnit}
          </span>
          <Badge variant={costStatusVariant(book.cost_status)}>
            {formatCostStatus(book.cost_status)}
          </Badge>
        </div>
        <div className="relative h-2 w-full max-w-md rounded-pill bg-charcoal-04">
          <div
            className="h-full rounded-pill bg-foreground transition-all"
            style={{ width: `${Math.min(warnPct, 100)}%` }}
          />
          <div
            className="absolute top-0 h-full w-px bg-destructive"
            style={{ left: `${costThresholdPercent(COST_THRESHOLD_WARN, COST_THRESHOLD_PAUSE)}%` }}
            title={m.header.costThresholdWarn}
          />
          <div
            className="absolute top-0 h-full w-px bg-destructive"
            style={{ left: '100%' }}
            title={m.header.costThresholdPause}
          />
        </div>
        <div className="flex gap-space-relaxed text-caption text-muted">
          <span>{m.header.costThresholdWarn}</span>
          <span>{m.header.costThresholdPause}</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Placeholder tab content for future sprints
// ---------------------------------------------------------------------------

function PlaceholderTab({ message }: { message: string }) {
  return (
    <div
      className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
      data-testid="placeholder-tab"
    >
      <p className="text-body text-muted">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BookDetailShell (main export)
// ---------------------------------------------------------------------------

interface BookDetailShellProps {
  book: BookDetailSerialized;
  costBreakdown: CostBreakdownSummary;
  evalResults: EvalResultSerialized[];
}

export function BookDetailShell({ book, costBreakdown, evalResults }: BookDetailShellProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('outline');

  const handleOutlineAction = useCallback(() => {
    router.refresh();
  }, [router]);

  return (
    <div className="flex flex-col gap-space-loose" data-testid="book-detail-shell">
      <BookHeader book={book} />

      {book.status === 'content_review' && (
        <ContentApprovalBanner bookId={book.id} />
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab} data-testid="book-tabs">
        <TabsList className="flex-wrap" data-testid="book-tabs-list">
          <TabsTrigger value="outline" data-testid="tab-outline">
            {m.tabs.outline}
          </TabsTrigger>
          <TabsTrigger value="chapters" data-testid="tab-chapters">
            {m.tabs.chapters}
          </TabsTrigger>
          <TabsTrigger value="cover" data-testid="tab-cover">
            {m.tabs.cover}
          </TabsTrigger>
          <TabsTrigger value="metadata" data-testid="tab-metadata">
            {m.tabs.metadata}
          </TabsTrigger>
          <TabsTrigger value="evaluation" data-testid="tab-evaluation">
            {m.tabs.evaluation}
          </TabsTrigger>
          <TabsTrigger value="cost" data-testid="tab-cost">
            {m.tabs.cost}
          </TabsTrigger>
          <TabsTrigger value="jobs" data-testid="tab-jobs">
            {m.tabs.jobs}
          </TabsTrigger>
          <TabsTrigger value="comments" data-testid="tab-comments">
            {m.tabs.comments}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="outline">
          <OutlineTab
            outline={book.outline}
            bookId={book.id}
            bookStatus={book.status}
            onAction={handleOutlineAction}
          />
        </TabsContent>

        <TabsContent value="chapters">
          <ChaptersTab
            chapters={book.chapters}
            bookStatus={book.status}
            bookId={book.id}
            comments={book.comments.filter((c) => c.target_kind === 'chapter')}
          />
        </TabsContent>

        <TabsContent value="cover">
          <CoverTab covers={book.covers} />
        </TabsContent>

        <TabsContent value="metadata">
          <PlaceholderTab message={m.metadata.placeholder} />
        </TabsContent>

        <TabsContent value="evaluation">
          <EvaluationHistoryTable results={evalResults} />
        </TabsContent>

        <TabsContent value="cost">
          <CostTab costBreakdown={costBreakdown} />
        </TabsContent>

        <TabsContent value="jobs">
          <JobHistoryTab jobs={book.jobs} />
        </TabsContent>

        <TabsContent value="comments">
          <PlaceholderTab message={m.commentTab.placeholder} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
