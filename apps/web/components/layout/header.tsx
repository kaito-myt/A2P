/**
 * Header — docs/04 §3.2。
 *
 * - 高さ 64px、`bg-cream`、下端に `border-warm` 1px (L1 Bordered §6.3.5)。
 * - 左: A2P ワードマーク
 * - 中央: グローバル検索 placeholder (SP-09 で本実装)
 * - 右: CostMeter / AlertBadge / CommentBadge / 設定 / ユーザーメニュー
 *
 * SP-06/SP-07 で 3 つのバッジに本値が接続される。本タスクではすべて 0 / "—"
 * のプレースホルダ表示で「常に視界に入る」レイアウトだけ確保する。
 */
import Link from 'next/link';
import Image from 'next/image';
import { messages } from '@/lib/messages';
import { CostMeter } from './cost-meter';
import { AlertBadge } from './alert-badge';
import { CommentBadgeHeader } from './comment-badge-header';

export function Header() {
  return (
    <header className="sticky top-0 z-10 flex h-16 items-center gap-space-relaxed border-b border-border-warm bg-cream px-space-loose">
      <Link
        href="/dashboard"
        aria-label={messages.brand.appName}
        className="flex shrink-0 items-center no-underline"
      >
        <Image
          src="/logo-mark.png"
          alt={messages.brand.appName}
          width={225}
          height={91}
          priority
          sizes="130px"
          style={{ height: 48, width: 'auto' }}
        />
      </Link>

      <div className="hidden flex-1 md:block">
        <input
          type="search"
          placeholder={messages.header.searchPlaceholder}
          aria-label={messages.header.searchPlaceholder}
          disabled
          className="w-full max-w-xl rounded-default border border-border-warm bg-cream-light px-3 py-2 text-button-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        />
      </div>

      <div className="ml-auto flex items-center gap-space-snug">
        <CostMeter />
        <AlertBadge />
        <CommentBadgeHeader />
        <span aria-label={messages.header.userMenuPlaceholder} className="rounded-pill bg-charcoal-04 px-3 py-1 text-button-sm text-charcoal-82">
          {messages.header.settingsLabel}
        </span>
      </div>
    </header>
  );
}
