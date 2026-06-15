/**
 * S-007 テーマ候補詳細 (T-03-08 / docs/04 §4 S-007 /
 *   docs/wireframes/S-007-theme-detail/prompt.md).
 *
 * Dynamic route: `/themes/[id]` (id = ThemeCandidate.id).
 *
 * 構成:
 *   1. ThemeDetailHeader — タイトル/サブタイトル/ステータス/メタ + パンくず
 *   2. ThemeSummarySection — hook / target_reader
 *   3. CompetitorsTable — competitors_json をテーブル表示
 *   4. WebSearchSnippetList — signals_json (reasoning / keywords / sources 等)
 *   5. ActionButtonGroup — 採用/却下/戻る (Client)
 *
 * T-06-05: CommentAffordance を ActionButtonGroup 内に配置。
 * 書籍紐付き済みの場合のみコメント追加可能 (target_kind='theme')。
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { prisma } from '@a2p/db';

import { ActionButtonGroup } from '@/components/themes/action-button-group';
import { CompetitorsTable } from '@/components/themes/competitors-table';
import { ThemeDetailHeader } from '@/components/themes/theme-detail-header';
import { ThemeSummarySection } from '@/components/themes/theme-summary-section';
import { WebSearchSnippetList } from '@/components/themes/web-search-snippet-list';
import { messages } from '@/lib/messages';
import { serializeThemeDetail, serializeThemeComment, type ThemeCommentSerialized } from '@/lib/themes-view';

export const metadata: Metadata = {
  title: `${messages.themes.detail.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

interface ThemeDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function ThemeDetailPage({ params }: ThemeDetailPageProps) {
  const { id } = await params;

  const raw = await prisma.themeCandidate.findUnique({
    where: { id },
    include: {
      books: {
        select: {
          id: true,
          revisionComments: {
            where: { target_kind: 'theme', target_id: id },
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
        take: 1,
      },
    },
  });

  if (!raw) {
    notFound();
  }

  const detail = serializeThemeDetail(raw);
  const linkedBook = raw.books[0] ?? null;
  const themeComments: ThemeCommentSerialized[] = linkedBook
    ? linkedBook.revisionComments.map(serializeThemeComment)
    : [];

  return (
    <div
      data-testid="theme-detail-page"
      className="flex flex-col gap-space-loose"
    >
      <ThemeDetailHeader detail={detail} />

      <ThemeSummarySection detail={detail} />

      <CompetitorsTable competitors={detail.competitors} />

      <WebSearchSnippetList signals={detail.signals} />

      <ActionButtonGroup
        themeId={detail.id}
        status={detail.status}
        bookId={linkedBook?.id ?? null}
        comments={themeComments}
      />
    </div>
  );
}
