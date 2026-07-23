/**
 * S-006 テーマ候補一覧 (docs/04 §4 S-006 / docs/wireframes/S-006-theme-candidates/prompt.md).
 *
 * 構成 (タスク T-03-07, 2026-07 改修):
 *   1. パンくず + ページタイトル + 右上 [+ 新規テーマ生成]
 *   2. サマリ (全件 / pending / accepted / rejected)
 *   3. ThemesPageShell — 生成中バナー + ステータス/ジャンル/期間フィルタ +
 *      ThemeCandidatesTable + BulkActionBar
 *
 * セッション別表示は廃止。全セッション横断でテーマを一覧し、ステータス
 * (pending/accepted/rejected/all) / ジャンル / 期間でフィルタする。過去に採用/却下した
 * テーマもフィルタ切替で確認できる。生成中のリクエストは上部バナーにチップ表示し、
 * クリックでリクエスト内容 (ジャンル/キーワード/生成数/アカウント) をポップアップ表示する。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { genreLabel } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { GenerateThemesButton } from '@/components/themes/generate-themes-button';
import { ThemesPageShell } from '@/components/themes/themes-page-shell';
import { messages } from '@/lib/messages';
import {
  serializeThemeRow,
  summarizeRows,
  sortThemesByRecommendation,
  type GeneratingSession,
} from '@/lib/themes-view';

export const metadata: Metadata = {
  title: `${messages.themes.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.themes;

/** 一覧に読み込む最大件数 (単一ユーザー運用の実用上限)。 */
const MAX_ROWS = 1000;

export default async function ThemesPage() {
  // 1. 全セッション横断でテーマを取得 (新しい順)。フィルタは Client 側で行う。
  const rawRows = await prisma.themeCandidate.findMany({
    orderBy: { created_at: 'desc' },
    take: MAX_ROWS,
  });
  const rows = sortThemesByRecommendation(rawRows.map(serializeThemeRow));
  const summary = summarizeRows(rows);

  // 2. アカウント一覧 (生成モーダル + 生成中バナーのアカウント名表示) + 著者/レーベル名マスタ
  const [accounts, authorNames, labelNames, allAccounts] = await Promise.all([
    prisma.account.findMany({
      where: { status: 'active' },
      select: { id: true, pen_name: true },
      orderBy: { created_at: 'asc' },
    }),
    prisma.authorName.findMany({
      where: { status: 'active' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.labelName.findMany({
      where: { status: 'active' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.account.findMany({ select: { id: true, pen_name: true } }),
  ]);
  const penNameById = new Map(allAccounts.map((a) => [a.id, a.pen_name]));

  // 3. 生成中セッション (未完了の pipeline.theme.generate ジョブ)。
  const generatingJobs = await prisma.job.findMany({
    where: { kind: 'pipeline.theme.generate', status: { in: ['queued', 'running'] } },
    orderBy: { created_at: 'desc' },
    take: 20,
    select: { id: true, status: true, payload_json: true, created_at: true },
  });
  const generatingSessions: GeneratingSession[] = generatingJobs.map((job) => {
    const p = (job.payload_json ?? {}) as Record<string, unknown>;
    const accountId = typeof p.account_id === 'string' ? p.account_id : null;
    const genreSlug = typeof p.genre === 'string' ? p.genre : null;
    return {
      jobId: job.id,
      sessionId: typeof p.theme_session_id === 'string' ? p.theme_session_id : null,
      genreLabel: genreSlug ? genreLabel(genreSlug) : null,
      keywordOrBrief: typeof p.keyword_or_brief === 'string' ? p.keyword_or_brief : null,
      count: typeof p.count === 'number' ? p.count : null,
      accountLabel: accountId ? (penNameById.get(accountId) ?? null) : null,
      status: job.status,
      createdAt: job.created_at.toISOString(),
    };
  });

  const hasContent = rows.length > 0 || generatingSessions.length > 0;

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
          <span>{m.breadcrumbThemes}</span>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-space-snug">
          <div className="flex flex-col">
            <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
            <p className="text-body text-muted">{m.pageSubtitle}</p>
          </div>
          <GenerateThemesButton accounts={accounts} authors={authorNames} labels={labelNames} />
        </div>
        {rows.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-x-space-relaxed gap-y-1 text-button-sm text-charcoal-82"
            data-testid="themes-summary"
          >
            <span data-testid="themes-summary-total">{m.summary.total(summary.total)}</span>
            <span data-testid="themes-summary-pending">{m.summary.pending(summary.pending)}</span>
            <span data-testid="themes-summary-accepted">
              {m.summary.accepted(summary.accepted)}
            </span>
            <span data-testid="themes-summary-rejected">
              {m.summary.rejected(summary.rejected)}
            </span>
          </div>
        )}
      </header>

      {hasContent ? (
        <ThemesPageShell rows={rows} generatingSessions={generatingSessions} />
      ) : (
        <div
          data-testid="themes-empty-state"
          className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        >
          <p className="text-body font-medium text-charcoal">{m.empty.title}</p>
          <p className="mt-2 text-body text-muted">{m.empty.body}</p>
          <div className="mt-space-snug flex justify-center">
            <GenerateThemesButton accounts={accounts} authors={authorNames} labels={labelNames} />
          </div>
        </div>
      )}
    </div>
  );
}
