/**
 * S-007 詳細ヘッダー (T-03-08).
 *
 * RSC で OK (selection state を持たない、Link は Next.js コンポーネント)。
 * タイトル / サブタイトル / ステータスバッジ / market_score / メタ情報 (ジャンル
 * / 生成日時 / セッション ID) + 一覧へ戻るリンクを表示する。
 */
import Link from 'next/link';

import { messages } from '@/lib/messages';
import { formatDateTime, type ThemeDetailSerialized } from '@/lib/themes-view';

import { ThemeStatusBadge } from './status-badge';

const m = messages.themes;
const md = m.detail;

interface ThemeDetailHeaderProps {
  detail: ThemeDetailSerialized;
}

export function ThemeDetailHeader({ detail }: ThemeDetailHeaderProps) {
  return (
    <header
      data-testid="theme-detail-header"
      className="flex flex-col gap-space-snug"
    >
      <nav aria-label="breadcrumb" className="text-button-sm text-muted">
        <Link href="/dashboard" className="no-underline hover:underline">
          {m.breadcrumbHome}
        </Link>
        <span aria-hidden="true"> &gt; </span>
        <span>{m.breadcrumbPipeline}</span>
        <span aria-hidden="true"> &gt; </span>
        <Link
          href="/themes"
          className="no-underline hover:underline"
          data-testid="theme-detail-back-link"
        >
          {m.breadcrumbThemes}
        </Link>
        <span aria-hidden="true"> &gt; </span>
        <span>{md.breadcrumbDetail}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-space-snug">
        <div className="flex flex-col gap-1">
          <h1
            data-testid="theme-detail-title"
            className="text-sub-heading text-foreground"
          >
            {detail.title}
          </h1>
          {detail.subtitle && (
            <p
              data-testid="theme-detail-subtitle"
              className="text-body text-charcoal-82"
            >
              {detail.subtitle}
            </p>
          )}
        </div>
        <div
          data-testid="theme-detail-status"
          className="flex items-center gap-space-snug"
        >
          <ThemeStatusBadge status={detail.status} rowId={detail.id} />
        </div>
      </div>

      <dl className="flex flex-wrap items-center gap-x-space-relaxed gap-y-1 text-button-sm text-charcoal-82">
        <div className="flex items-center gap-1">
          <dt>{md.headerMeta.marketScore}:</dt>
          <dd data-testid="theme-detail-market-score">
            {detail.market_score !== null
              ? `${detail.market_score} ${md.headerMeta.marketScoreSuffix}`
              : md.headerMeta.marketScoreEmpty}
          </dd>
        </div>
        <div className="flex items-center gap-1">
          <dt>{md.headerMeta.genre}:</dt>
          <dd data-testid="theme-detail-genre">{detail.genre}</dd>
        </div>
        <div className="flex items-center gap-1">
          <dt>{md.headerMeta.createdAt}:</dt>
          <dd data-testid="theme-detail-created-at">
            {formatDateTime(detail.created_at)}
          </dd>
        </div>
        <div className="flex items-center gap-1">
          <dt>{md.headerMeta.decidedAt}:</dt>
          <dd data-testid="theme-detail-decided-at">
            {detail.decided_at
              ? formatDateTime(detail.decided_at)
              : md.headerMeta.decidedAtEmpty}
          </dd>
        </div>
        <div className="flex items-center gap-1">
          <dt>{md.headerMeta.sessionId}:</dt>
          <dd data-testid="theme-detail-session-id">{detail.theme_session_id}</dd>
        </div>
      </dl>
    </header>
  );
}
