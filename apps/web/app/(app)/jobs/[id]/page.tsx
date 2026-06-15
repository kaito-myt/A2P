/**
 * S-026 ジョブ詳細・実行ログ (T-09-02, F-016/F-045/F-046).
 *
 * Dynamic route: `/jobs/[id]` (id = Job.id).
 *
 * 2-column layout:
 *   - Left 70%: PayloadJsonViewer / LogStreamViewer / ErrorDetail
 *   - Right 30%: TokenUsageInline / JobMetaCard / ActionGroup
 *
 * 仕様根拠: docs/04 S-026 / docs/05 §4.3.14 / SP-09 T-09-02
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import { serializeJobDetail, type JobDetailRawRow } from '@/lib/jobs-view';
import { JobDetailShell } from '@/components/jobs/job-detail-shell';

export const metadata: Metadata = {
  title: `${messages.jobs.detail.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.jobs.detail;

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function JobDetailPage({ params }: PageProps) {
  const { id } = await params;

  const raw = await prisma.job.findUnique({
    where: { id },
    include: {
      book: {
        select: {
          id: true,
          title: true,
          covers: {
            where: { status: 'adopted' },
            select: { r2_key: true, status: true },
            take: 1,
          },
        },
      },
      tokenUsages: {
        select: {
          id: true,
          provider: true,
          model: true,
          role: true,
          input_tokens: true,
          output_tokens: true,
          cached_input_tokens: true,
          image_count: true,
          cost_jpy: true,
          created_at: true,
        },
        orderBy: { created_at: 'asc' },
      },
    },
  });

  if (!raw) {
    notFound();
  }

  const job = serializeJobDetail(raw as unknown as JobDetailRawRow);

  return (
    <div className="flex flex-col gap-space-loose" data-testid="job-detail-page">
      {/* Breadcrumb */}
      <nav aria-label="breadcrumb" className="text-button-sm text-muted">
        <Link href="/dashboard" className="no-underline hover:underline">
          {m.breadcrumbHome}
        </Link>
        <span aria-hidden="true"> &gt; </span>
        <span>{m.breadcrumbOps}</span>
        <span aria-hidden="true"> &gt; </span>
        <Link href="/jobs" className="no-underline hover:underline">
          {m.breadcrumbJobs}
        </Link>
        <span aria-hidden="true"> &gt; </span>
        <span>{job.id.slice(0, 12)}&hellip;</span>
      </nav>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-sub-heading text-foreground">
            {m.pageTitle} — {job.id.slice(0, 16)}&hellip;
          </h1>
        </div>
        {job.book_id && (
          <Link
            href={`/books/${job.book_id}`}
            className="text-button-sm text-accent no-underline hover:underline"
          >
            {m.actionGoBook}
          </Link>
        )}
      </div>

      <JobDetailShell job={job} />
    </div>
  );
}
