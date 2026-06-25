/**
 * S-015 KDP 入稿チェックリスト 書籍詳細 RSC ページ。
 *
 * 一覧 (/kdp/checklist) からクリックして遷移する 1 冊分の詳細。
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import { serializeChecklistBook } from '@/lib/kdp-checklist-view';
import { ChecklistDetailShell } from '@/components/kdp-checklist/checklist-detail-shell';

export const metadata: Metadata = {
  title: `${messages.kdpChecklist.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.kdpChecklist;

export default async function KdpChecklistDetailPage({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = await params;

  const bookRaw = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
      title: true,
      subtitle: true,
      publish_status: true,
      has_blocking_comments: true,
      account: { select: { pen_name: true } },
      kdpMetadata: {
        select: {
          description: true,
          categories: true,
          keywords: true,
          price_jpy: true,
        },
      },
      covers: {
        select: { id: true, r2_key: true, status: true },
        orderBy: { created_at: 'desc' },
      },
      artifacts: {
        select: { id: true, kind: true, r2_key: true },
        where: { kind: { in: ['docx', 'pdf', 'png_cover'] } },
      },
      kdpSubmissionProgress: {
        select: { checklist_state_json: true, updated_at: true },
      },
      revisionComments: {
        select: { id: true, body: true, priority: true, status: true, target_kind: true },
        where: { priority: 'must', status: 'pending' },
      },
    },
  });

  if (!bookRaw) {
    notFound();
  }

  const book = serializeChecklistBook(bookRaw);

  return (
    <div className="flex flex-col gap-space-loose" data-testid="kdp-checklist-detail-page">
      <header className="flex items-start justify-between gap-space-snug">
        <div className="flex flex-col gap-space-snug">
          <nav aria-label="breadcrumb" className="text-button-sm text-muted">
            <Link href="/dashboard" className="no-underline hover:underline">
              {m.breadcrumbHome}
            </Link>
            <span aria-hidden="true"> &gt; </span>
            <Link href="/kdp/checklist" className="no-underline hover:underline">
              {m.pageTitle}
            </Link>
            <span aria-hidden="true"> &gt; </span>
            <span className="max-w-[20ch] truncate align-bottom">{book.title}</span>
          </nav>
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
        </div>
        <a
          href="https://kdp.amazon.co.jp/bookshelf"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04"
          aria-label={m.openKdpAriaLabel}
        >
          {m.openKdp}
        </a>
      </header>

      <ChecklistDetailShell book={book} />
    </div>
  );
}
