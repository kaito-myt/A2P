/**
 * S-012 サムネ承認 (T-05-10, F-006/F-007/F-014/F-019).
 *
 * RSC 構成 (outlines/page.tsx と同型):
 *   1. パンくず + タイトル + サマリ (承認待ち件数 / 対象冊数 / 候補枚数)
 *   2. thumbnail ステータスの Book を Cover + CoverTextProposal join で取得
 *   3. CoversPageShell (Client) へ渡す
 *   4. 空状態は EmptyState ブロック
 *
 * 取得スコープ:
 *  - Book.status = 'thumbnail' (サムネ生成完了 → 承認待ち)
 *  - 各 Book の Cover (全 status) と CoverTextProposal を取得
 *  - 上限 100 冊
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { CoversPageShell } from '@/components/covers/covers-page-shell';
import { messages } from '@/lib/messages';
import {
  serializeBookCoverGroup,
  summarizeCovers,
} from '@/lib/covers-view';

export const metadata: Metadata = {
  title: `${messages.covers.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.covers;

export default async function CoversApprovalPage() {
  const rawBooks = await prisma.book.findMany({
    where: { status: 'thumbnail' },
    orderBy: { created_at: 'desc' },
    take: 100,
    include: {
      theme: { select: { genre: true } },
      covers: {
        orderBy: { created_at: 'asc' },
      },
      coverTextProposals: {
        orderBy: { created_at: 'asc' },
      },
      revisionComments: {
        where: {
          target_kind: { in: ['cover', 'cover_text'] },
        },
        select: {
          id: true,
          book_id: true,
          target_kind: true,
          target_id: true,
          range_json: true,
          body: true,
          priority: true,
          status: true,
          created_at: true,
          applied_at: true,
        },
        orderBy: { created_at: 'desc' },
      },
    },
  });

  const groups = rawBooks.map(serializeBookCoverGroup);
  const summary = summarizeCovers(groups);

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
          <span>{m.breadcrumbCovers}</span>
        </nav>
        <div className="flex flex-col">
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
        {groups.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-x-space-relaxed gap-y-1 text-button-sm text-charcoal-82"
            data-testid="covers-summary"
          >
            <span data-testid="covers-summary-pending">
              {m.summary.pending(summary.pendingBooks)}
            </span>
            <span data-testid="covers-summary-books">
              {m.summary.booksAffected(groups.length)}
            </span>
            <span data-testid="covers-summary-covers">
              {m.summary.totalCovers(summary.totalCovers)}
            </span>
          </div>
        )}
      </header>

      {groups.length === 0 ? (
        <div
          data-testid="covers-empty-state"
          className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        >
          <p className="text-body font-medium text-charcoal">{m.empty.title}</p>
          <p className="mt-2 text-body text-muted">{m.empty.body}</p>
          <div className="mt-space-snug flex justify-center">
            <Link
              href="/books"
              className="text-button-sm text-foreground underline hover:no-underline"
              data-testid="covers-empty-cta"
            >
              {m.empty.cta}
            </Link>
          </div>
        </div>
      ) : (
        <CoversPageShell groups={groups} />
      )}
    </div>
  );
}
