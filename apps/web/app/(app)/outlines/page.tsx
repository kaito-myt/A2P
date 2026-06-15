/**
 * S-011 アウトライン承認 (docs/04 §4 S-011, T-04-08).
 *
 * RSC 構成 (themes/page.tsx と同型):
 *   1. パンくず + タイトル + サマリ (承認待ち件数 / 想定総文字数 / 影響冊数)
 *   2. pending_review の Outline を Book/Theme join 込みで取得して
 *      OutlinesPageShell (Client) へ渡す
 *   3. 空状態は EmptyState ブロック
 *
 * 取得スコープ:
 *  - status='pending_review' の Outline のみ (承認/差戻し対象)
 *  - approved/rejected は履歴扱い、現状ここでは表示しない (S-010 で個別確認)
 *  - 上限 100 件 (bulkApprove/bulkReject SA の zod max と整合)
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { OutlinesPageShell } from '@/components/outlines/outlines-page-shell';
import { messages } from '@/lib/messages';
import {
  serializeOutlineRow,
  serializeOutlineComment,
  summarizeOutlines,
} from '@/lib/outlines-view';

export const metadata: Metadata = {
  title: `${messages.outlines.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.outlines;

export default async function OutlinesApprovalPage() {
  const rawRows = await prisma.outline.findMany({
    where: { status: 'pending_review' },
    orderBy: { created_at: 'desc' },
    take: 100,
    include: {
      book: {
        select: {
          id: true,
          title: true,
          account_id: true,
          status: true,
          theme: { select: { genre: true } },
          revisionComments: {
            where: { target_kind: 'outline' },
            select: {
              id: true,
              book_id: true,
              target_kind: true,
              target_id: true,
              body: true,
              priority: true,
              status: true,
              created_at: true,
            },
            orderBy: { created_at: 'desc' },
          },
        },
      },
    },
  });

  const rows = rawRows.map(serializeOutlineRow);
  const commentsByOutlineId = new Map<string, ReturnType<typeof serializeOutlineComment>[]>();
  for (const raw of rawRows) {
    if (raw.book?.revisionComments) {
      const serialized = raw.book.revisionComments
        .filter((c) => c.target_id === raw.id)
        .map(serializeOutlineComment);
      if (serialized.length > 0) {
        commentsByOutlineId.set(raw.id, serialized);
      }
    }
  }
  const commentsMap = Object.fromEntries(commentsByOutlineId);
  const summary = summarizeOutlines(rows);

  return (
    <div className="flex flex-col gap-space-loose">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbPipeline}</span>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbOutlines}</span>
        </nav>
        <div className="flex flex-col">
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
        {rows.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-x-space-relaxed gap-y-1 text-button-sm text-charcoal-82"
            data-testid="outlines-summary"
          >
            <span data-testid="outlines-summary-pending">
              {m.summary.pending(summary.pending)}
            </span>
            <span data-testid="outlines-summary-books">
              {m.summary.booksAffected(summary.booksAffected)}
            </span>
            <span data-testid="outlines-summary-total-chars">
              {m.summary.totalChars(summary.totalTargetChars)}
            </span>
          </div>
        )}
      </header>

      {rows.length === 0 ? (
        <div
          data-testid="outlines-empty-state"
          className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        >
          <p className="text-body font-medium text-charcoal">{m.empty.title}</p>
          <p className="mt-2 text-body text-muted">{m.empty.body}</p>
          <div className="mt-space-snug flex justify-center">
            <Link
              href="/batches/new"
              className="text-button-sm text-foreground underline hover:no-underline"
              data-testid="outlines-empty-cta"
            >
              {m.empty.cta}
            </Link>
          </div>
        </div>
      ) : (
        <OutlinesPageShell rows={rows} commentsMap={commentsMap} />
      )}
    </div>
  );
}
