/**
 * S-014 修正一括反映 進捗・diff レビュー (T-06-09).
 *
 * Dynamic route: `/revision-runs/[id]` (id = RevisionRun.id).
 *
 * RSC: fetches RevisionRun + comments + books + chapterRevisions + tokenUsage,
 * serializes and passes to RevisionRunShell client component.
 *
 * 参照: docs/04 S-014, docs/wireframes/S-014-revision-run/prompt.md
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { prisma } from '@a2p/db';

import { RevisionRunShell } from '@/components/revision-runs/revision-run-shell';
import { messages } from '@/lib/messages';
import { serializeRevisionRun } from '@/lib/revision-runs-view';

export const metadata: Metadata = {
  title: `${messages.revisionRuns.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.revisionRuns;

interface RevisionRunPageProps {
  params: Promise<{ id: string }>;
}

export default async function RevisionRunPage({ params }: RevisionRunPageProps) {
  const { id } = await params;

  const run = await prisma.revisionRun.findUnique({
    where: { id },
  });

  if (!run) {
    notFound();
  }

  const rawComments = await prisma.revisionComment.findMany({
    where: { run_id: id },
    orderBy: { created_at: 'asc' },
    include: {
      book: {
        select: { id: true, title: true },
      },
    },
  });

  const bookIds = Array.isArray(run.book_ids_json)
    ? (run.book_ids_json as string[])
    : [];

  const books = bookIds.length > 0
    ? await prisma.book.findMany({
        where: { id: { in: bookIds } },
        select: { id: true, title: true },
      })
    : [];

  const chapterCommentTargetIds = rawComments
    .filter((c) => c.target_kind === 'chapter')
    .map((c) => c.target_id);

  const chapters = chapterCommentTargetIds.length > 0
    ? await prisma.chapter.findMany({
        where: { id: { in: [...new Set(chapterCommentTargetIds)] } },
        select: { id: true, index: true, heading: true, body_md: true },
      })
    : [];

  const chapterIds = chapters.map((c) => c.id);
  const chapterRevisions = chapterIds.length > 0
    ? await prisma.chapterRevision.findMany({
        where: {
          chapter_id: { in: chapterIds },
          reason: `revision_run:${id}`,
        },
        select: { chapter_id: true, version: true, body_md: true },
        orderBy: { version: 'desc' },
      })
    : [];

  const costWhere: Parameters<typeof prisma.tokenUsage.groupBy>[0]['where'] =
    bookIds.length > 0
      ? {
          book_id: { in: bookIds },
          role: 'revision',
          created_at: {
            gte: run.triggered_at,
            ...(run.finished_at ? { lte: run.finished_at } : {}),
          },
        }
      : { id: '__impossible__' };

  const costGroupBy = bookIds.length > 0
    ? await prisma.tokenUsage.groupBy({
        by: ['provider', 'model', 'role'],
        where: costWhere,
        _sum: {
          input_tokens: true,
          output_tokens: true,
          cost_jpy: true,
        },
        _count: { _all: true },
      })
    : [];

  const serialized = serializeRevisionRun(
    run,
    rawComments as Parameters<typeof serializeRevisionRun>[1],
    books,
    chapters,
    chapterRevisions,
    costGroupBy as Parameters<typeof serializeRevisionRun>[5],
  );

  return (
    <div
      className="flex flex-col gap-space-loose"
      data-testid="revision-run-page"
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
        <Link href="/comments" className="no-underline hover:underline">
          {m.breadcrumbComments}
        </Link>
        <span aria-hidden="true"> &gt; </span>
        <span>{m.breadcrumbRun} #{serialized.id.slice(0, 8)}</span>
      </nav>

      <RevisionRunShell run={serialized} />
    </div>
  );
}
