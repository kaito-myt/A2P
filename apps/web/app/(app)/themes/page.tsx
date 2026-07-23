/**
 * S-006 テーマ候補一覧 (docs/04 §4 S-006 / docs/wireframes/S-006-theme-candidates/prompt.md).
 *
 * 構成 (タスク T-03-07):
 *   1. パンくず + ページタイトル + 右上 [+ 新規テーマ生成]
 *   2. セッションサマリ (全件 / pending / accepted / rejected)
 *   3. ThemeCandidatesTable + BulkActionBar (Client Component で selection state を持つ)
 *
 * セッション切替: `?theme_session_id=<cuid>` を渡せば特定セッション表示、無ければ
 * 最新セッション (theme_candidates.created_at desc の先頭行の session_id)。
 * 未生成時は空状態表示 + 生成 CTA。
 *
 * フィルタバー (account/genre/日時) は wireframes prompt にあるが、本タスクの
 * 主軸はバルク承認 SA なので、最初は session 切替のみで十分。フィルタの本実装は
 * 後続タスクで追加する余地を残す (テーブル自体は事前計算 server-side で完結)。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { GenerateThemesButton } from '@/components/themes/generate-themes-button';
import { GeneratingBanner } from '@/components/themes/generating-banner';
import { ThemesPageShell } from '@/components/themes/themes-page-shell';
import { messages } from '@/lib/messages';
import { serializeThemeRow, summarizeRows, sortThemesByRecommendation } from '@/lib/themes-view';

export const metadata: Metadata = {
  title: `${messages.themes.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.themes;

interface ThemesPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ThemesPage({ searchParams }: ThemesPageProps) {
  const params = await searchParams;
  const explicitSessionId =
    typeof params.theme_session_id === 'string' ? params.theme_session_id : null;

  // 1. 表示対象セッション ID を決める
  const sessionId = explicitSessionId
    ? explicitSessionId
    : (
        await prisma.themeCandidate.findFirst({
          orderBy: { created_at: 'desc' },
          select: { theme_session_id: true },
        })
      )?.theme_session_id ?? null;

  // 2. 該当セッションの全行 (なければ空)
  const rawRows = sessionId
    ? await prisma.themeCandidate.findMany({
        where: { theme_session_id: sessionId },
        orderBy: { created_at: 'desc' },
      })
    : [];

  // おすすめ順 (market_score 降順) で並べる — Marketer の Amazon 売れ筋レコメンド反映。
  const rows = sortThemesByRecommendation(rawRows.map(serializeThemeRow));
  const summary = summarizeRows(rows);

  // テーマ生成モーダル用に有効アカウント一覧 + 著者名/レーベル名マスタを取得
  const [accounts, authorNames, labelNames] = await Promise.all([
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
  ]);

  // 過去のテーマ生成セッション一覧（切替用）。「前のリクエストが消えた」ように見えるのは
  // 最新セッションしか表示していなかったため — ここで過去セッションへ辿れるようにする。
  const sessionGroups = await prisma.themeCandidate.groupBy({
    by: ['theme_session_id'],
    _count: { _all: true },
    _max: { created_at: true },
    orderBy: { _max: { created_at: 'desc' } },
    take: 12,
  });
  const sessionList = sessionGroups.map((g) => ({
    id: g.theme_session_id,
    count: g._count._all,
    createdAt: g._max.created_at ? g._max.created_at.toISOString().slice(5, 16).replace('T', ' ') : '',
  }));

  // このセッションのテーマ生成ジョブが進行中か (候補が出るまで「生成中」表示)
  const generatingCount = sessionId
    ? await prisma.job.count({
        where: {
          kind: 'pipeline.theme.generate',
          status: { in: ['queued', 'running'] },
          payload_json: { path: ['theme_session_id'], equals: sessionId },
        },
      })
    : 0;
  const isGenerating = generatingCount > 0 && rows.length === 0;

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
          <div className="flex items-center gap-space-snug">
            <GenerateThemesButton accounts={accounts} authors={authorNames} labels={labelNames} />
          </div>
        </div>
        {sessionList.length > 1 && (
          <div className="flex flex-col gap-1" data-testid="themes-session-switcher">
            <span className="text-caption text-muted">{m.sessionSwitcherLabel}</span>
            <div className="flex flex-wrap gap-1.5">
              {sessionList.map((s) => {
                const active = s.id === sessionId;
                return (
                  <Link
                    key={s.id}
                    href={`/themes?theme_session_id=${s.id}`}
                    className={
                      active
                        ? 'rounded-pill bg-charcoal px-2.5 py-1 text-caption text-cream-light'
                        : 'rounded-pill border border-border-warm bg-cream px-2.5 py-1 text-caption text-charcoal-82 hover:bg-cream-light'
                    }
                  >
                    {s.createdAt}（{s.count}）
                  </Link>
                );
              })}
            </div>
          </div>
        )}
        {sessionId && (
          <div
            className="flex flex-wrap items-center gap-x-space-relaxed gap-y-1 text-button-sm text-charcoal-82"
            data-testid="themes-summary"
          >
            <span data-testid="themes-summary-session">
              {m.sessionLabel}: {sessionId}
            </span>
            <span data-testid="themes-summary-total">{m.summary.total(summary.total)}</span>
            <span data-testid="themes-summary-pending">
              {m.summary.pending(summary.pending)}
            </span>
            <span data-testid="themes-summary-accepted">
              {m.summary.accepted(summary.accepted)}
            </span>
            <span data-testid="themes-summary-rejected">
              {m.summary.rejected(summary.rejected)}
            </span>
          </div>
        )}
      </header>

      {isGenerating ? (
        <GeneratingBanner />
      ) : rows.length === 0 ? (
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
      ) : (
        <ThemesPageShell rows={rows} />
      )}
    </div>
  );
}
