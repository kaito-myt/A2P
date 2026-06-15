/**
 * S-010 書籍詳細・章エディタ (T-04-09).
 *
 * Dynamic route: `/books/[id]` (id = Book.id).
 *
 * 構成:
 *   1. パンくず + BookHeader (タイトル / status / Quality / コスト + 500/750 円ライン)
 *   2. TabbedContent: アウトライン / 章本文 / カバー / メタデータ / 評価履歴 / コスト内訳 / ジョブ履歴 / コメント
 *
 * SP-05/06/10 で実装予定のタブは placeholder。
 * 章本文 Markdown ビューアは T-04-10 で実装。
 *
 * 参照: docs/04 §4 S-010, docs/wireframes/S-010-book-detail/prompt.md
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { prisma } from '@a2p/db';

import { BookDetailShell } from '@/components/books/book-detail-shell';
import { messages } from '@/lib/messages';
import { serializeBookDetail } from '@/lib/books-view';
import { serializeCostGroupBy, type CostGroupByRaw } from '@/lib/cost-view';
import { serializeEvalResults } from '@/lib/eval-history-view';

export const metadata: Metadata = {
  title: `${messages.books.detailPageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.books;

interface BookDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function BookDetailPage({ params }: BookDetailPageProps) {
  const { id } = await params;

  const raw = await prisma.book.findUnique({
    where: { id },
    include: {
      account: {
        select: { id: true, pen_name: true },
      },
      theme: {
        select: { genre: true },
      },
      outline: {
        select: {
          id: true,
          status: true,
          reject_note: true,
          approved_at: true,
          created_at: true,
          chapters_json: true,
        },
      },
      chapters: {
        select: {
          id: true,
          index: true,
          heading: true,
          body_md: true,
          status: true,
          char_count: true,
          version: true,
          updated_at: true,
        },
        orderBy: { index: 'asc' },
      },
      jobs: {
        select: {
          id: true,
          kind: true,
          status: true,
          started_at: true,
          finished_at: true,
          created_at: true,
          error: true,
          retries: true,
        },
        orderBy: { created_at: 'desc' },
        take: 50,
      },
      revisionComments: {
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

  if (!raw) {
    notFound();
  }

  const costRaw = await prisma.tokenUsage.groupBy({
    by: ['provider', 'model', 'role'],
    where: { book_id: id },
    _sum: {
      input_tokens: true,
      output_tokens: true,
      cached_input_tokens: true,
      image_count: true,
      cost_jpy: true,
    },
    _count: { _all: true },
  });

  const evalRaw = await prisma.evalResult.findMany({
    where: { book_id: id },
    orderBy: { judged_at: 'desc' },
    take: 20,
    select: {
      id: true,
      book_id: true,
      score_total: true,
      score_breakdown_json: true,
      judge_comments_json: true,
      triggered_by: true,
      judged_at: true,
    },
  });

  const book = serializeBookDetail(raw);
  const costBreakdown = serializeCostGroupBy(costRaw as unknown as CostGroupByRaw[]);
  const evalResults = serializeEvalResults(evalRaw);

  return (
    <div
      className="flex flex-col gap-space-loose"
      data-testid="book-detail-page"
    >
      <nav aria-label="breadcrumb" className="text-button-sm text-muted">
        <Link href="/dashboard" className="no-underline hover:underline">
          {m.breadcrumbHome}
        </Link>
        <span aria-hidden="true"> &gt; </span>
        <Link href="/books" className="no-underline hover:underline">
          {m.breadcrumbBooks}
        </Link>
        <span aria-hidden="true"> &gt; </span>
        <span>{book.title}</span>
      </nav>

      <BookDetailShell book={book} costBreakdown={costBreakdown} evalResults={evalResults} />
    </div>
  );
}
