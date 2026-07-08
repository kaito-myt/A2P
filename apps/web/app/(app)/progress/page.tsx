/**
 * 進行状況 (F-054) — テーマ生成・本文作成など、いま何が動いていて何%かを一覧する。
 */
import type { Metadata } from 'next';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import { ProgressBoard } from '@/components/progress/progress-board';
import {
  computeBookProgress,
  type BookProgress,
  type ThemeGenerating,
} from '@/lib/progress-view';

export const metadata: Metadata = {
  title: `${messages.progress.pageTitle} | ${messages.brand.appName}`,
};
export const dynamic = 'force-dynamic';

const PROCESSING = ['queued', 'running', 'editing', 'thumbnail', 'judging', 'exporting'];

export default async function ProgressPage() {
  const nowMs = Date.now();

  const books = await prisma.book.findMany({
    where: { status: { in: PROCESSING } },
    orderBy: { updated_at: 'asc' },
    select: {
      id: true,
      title: true,
      status: true,
      updated_at: true,
      outline: { select: { chapters_json: true } },
      _count: { select: { chapters: true } },
    },
  });

  const bookProgress: BookProgress[] = await Promise.all(
    books.map(async (b) => {
      const total = Array.isArray(b.outline?.chapters_json)
        ? (b.outline!.chapters_json as unknown[]).length
        : null;
      const latestJob = await prisma.job.findFirst({
        where: { book_id: b.id },
        orderBy: { created_at: 'desc' },
        select: { kind: true, status: true, error: true },
      });
      return computeBookProgress({
        id: b.id,
        title: b.title,
        status: b.status,
        updatedAtMs: b.updated_at instanceof Date ? b.updated_at.getTime() : nowMs,
        nowMs,
        chaptersDone: b._count.chapters,
        chaptersTotal: total,
        latestJobKind: latestJob?.kind ?? null,
        latestJobStatus: latestJob?.status ?? null,
        latestJobError: latestJob?.error ?? null,
      });
    }),
  );

  // テーマ生成中セッション
  const themeJobs = await prisma.job.findMany({
    where: { kind: 'pipeline.theme.generate', status: { in: ['queued', 'running'] } },
    orderBy: { created_at: 'desc' },
    take: 20,
    select: { payload_json: true, started_at: true, created_at: true },
  });
  const accountIds = Array.from(
    new Set(
      themeJobs
        .map((j) => (j.payload_json as { account_id?: string } | null)?.account_id)
        .filter((v): v is string => typeof v === 'string'),
    ),
  );
  const accounts = accountIds.length
    ? await prisma.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, pen_name: true } })
    : [];
  const accountMap = new Map(accounts.map((a) => [a.id, a.pen_name]));
  const themesGenerating: ThemeGenerating[] = themeJobs.map((j) => {
    const p = j.payload_json as { account_id?: string; theme_session_id?: string } | null;
    const startMs = (j.started_at ?? j.created_at) instanceof Date ? (j.started_at ?? j.created_at)!.getTime() : nowMs;
    return {
      sessionId: p?.theme_session_id ?? '',
      accountName: p?.account_id ? accountMap.get(p.account_id) ?? null : null,
      startedMinutes: Math.max(0, Math.round((nowMs - startMs) / 60000)),
    };
  });

  return <ProgressBoard books={bookProgress} themes={themesGenerating} />;
}
