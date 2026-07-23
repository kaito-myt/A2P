/**
 * 法務ページ共通レイアウト (公開・未認証で閲覧可)。
 * 認証アプリシェル (サイドバー等) は付けず、読みやすい単一カラムで表示する。
 */
import type { ReactNode } from 'react';
import Link from 'next/link';

import { LEGAL } from './config';

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-cream">
      <main className="mx-auto flex max-w-2xl flex-col gap-6 px-5 py-12">
        <nav className="flex items-center gap-4 text-caption text-muted">
          <Link href="/legal/privacy" className="hover:text-charcoal hover:underline">
            プライバシーポリシー
          </Link>
          <span aria-hidden>·</span>
          <Link href="/legal/terms" className="hover:text-charcoal hover:underline">
            利用規約
          </Link>
        </nav>
        <article className="flex flex-col gap-5 text-body leading-relaxed text-charcoal-82">
          {children}
        </article>
        <footer className="mt-8 border-t border-border-warm pt-4 text-caption text-muted">
          {LEGAL.operator} — {LEGAL.serviceName}
        </footer>
      </main>
    </div>
  );
}
