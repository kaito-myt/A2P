/**
 * S-015 KDP 入稿チェックリスト RSC ページ (T-08-03, F-020/F-040/F-049).
 *
 * 入稿待ち書籍 (done ステータス or has_blocking_comments 問わず) を全件取得して
 * クライアントシェルに渡す。
 *
 * 仕様根拠: docs/04 S-015 / SP-08 T-08-03
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import { serializeChecklistPage } from '@/lib/kdp-checklist-view';
import { EmptyState } from '@/components/common/empty-state';
import { ChecklistList } from '@/components/kdp-checklist/checklist-list';

export const metadata: Metadata = {
  title: `${messages.kdpChecklist.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.kdpChecklist;

export default async function KdpChecklistPage() {
  // 入稿対象 = done 状態の書籍 + metadata あり/なし 両方含む (運営者が確認できるよう全件)
  // 失敗/取消/アーカイブは除外
  // 入稿リストの掲載条件: done / needs_human_review かつ「出版済み」でない。
  // 運営者が詳細で入稿/出版ステータスを「出版済み」にすると、このリストから外れる
  // (= 入稿作業が完了したものを自動的に片付ける)。「入稿済み」はまだ表示し続ける。
  const booksRaw = await prisma.book.findMany({
    where: {
      status: { in: ['done', 'needs_human_review'] },
      publish_status: { not: 'published' },
    },
    orderBy: { done_at: 'desc' },
    select: {
      id: true,
      title: true,
      subtitle: true,
      publish_status: true,
      has_blocking_comments: true,
      account: {
        select: { pen_name: true },
      },
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
        select: {
          checklist_state_json: true,
          updated_at: true,
        },
      },
      revisionComments: {
        select: {
          id: true,
          body: true,
          priority: true,
          status: true,
          target_kind: true,
        },
        where: {
          priority: 'must',
          status: 'pending',
        },
      },
    },
  });

  const data = serializeChecklistPage(booksRaw);

  if (data.books.length === 0) {
    return (
      <div className="flex flex-col gap-space-loose" data-testid="kdp-checklist-page">
        <header className="flex flex-col gap-space-snug">
          <nav aria-label="breadcrumb" className="text-button-sm text-muted">
            <Link href="/dashboard" className="no-underline hover:underline">
              {m.breadcrumbHome}
            </Link>
            <span aria-hidden="true"> &gt; </span>
            <span>{m.breadcrumbPipeline}</span>
            <span aria-hidden="true"> &gt; </span>
            <span>{m.pageTitle}</span>
          </nav>
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
        </header>

        <EmptyState
          title={m.empty.title}
          message={m.empty.body}
          action={
            <Link
              href="/books"
              className="inline-flex items-center rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04"
            >
              {m.empty.cta}
            </Link>
          }
          data-testid="kdp-checklist-empty"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-space-loose" data-testid="kdp-checklist-page">
      <header className="flex items-start justify-between gap-space-snug">
        <div className="flex flex-col gap-space-snug">
          <nav aria-label="breadcrumb" className="text-button-sm text-muted">
            <Link href="/dashboard" className="no-underline hover:underline">
              {m.breadcrumbHome}
            </Link>
            <span aria-hidden="true"> &gt; </span>
            <span>{m.breadcrumbPipeline}</span>
            <span aria-hidden="true"> &gt; </span>
            <span>{m.pageTitle}</span>
          </nav>
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
        </div>
        <a
          href="https://kdp.amazon.co.jp/bookshelf"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex shrink-0 items-center gap-1.5 rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04"
          data-testid="kdp-open-link"
          aria-label={m.openKdpAriaLabel}
        >
          <ExternalLinkIcon />
          {m.openKdp}
        </a>
      </header>

      <ChecklistList books={data.books} />
    </div>
  );
}

function ExternalLinkIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}
