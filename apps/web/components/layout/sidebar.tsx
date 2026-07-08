'use client';

/**
 * Sidebar — docs/04 §3.3 (cool-neutral SaaS リフレッシュ)。
 *
 * - 固定幅 240px、白サーフェス (`bg-cream-light`)、右端に 1px 縦罫線。
 * - 現在ページをアクセント (indigo) でハイライトする。
 * - Phase 1 で未実装の画面は disabled。
 * - 下部に JobTicker。
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { navSections } from './nav-items';
import { JobTicker } from './job-ticker';
import { messages } from '@/lib/messages';
import { cn } from '@/lib/cn';

/** href が現在パスにマッチするか (完全一致 or サブパス)。ダッシュボードは完全一致のみ。 */
function isActivePath(pathname: string, href: string): boolean {
  if (href === '/dashboard') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname() ?? '';

  return (
    <aside
      aria-label={messages.nav.sidebarAriaLabel}
      data-testid="sidebar-nav"
      className="flex h-full w-60 shrink-0 flex-col border-r border-border-warm bg-cream-light"
    >
      <nav className="scrollbar-none flex-1 overflow-y-auto px-3 py-space-loose">
        {navSections.map((section) => (
          <div key={section.key} className="mb-space-relaxed last:mb-0">
            <div className="px-2 pb-1.5 text-caption font-medium uppercase tracking-wide text-charcoal-40">
              {section.label}
            </div>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = item.enabled && isActivePath(pathname, item.href);
                return (
                  <li key={item.key}>
                    {item.enabled ? (
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        {...(item.external
                          ? { target: '_blank', rel: 'noopener noreferrer' }
                          : {})}
                        className={cn(
                          'block rounded-snug px-2.5 py-1.5 text-button-sm no-underline transition-colors',
                          active
                            ? 'bg-accent-bg font-medium text-accent'
                            : 'text-charcoal-82 hover:bg-charcoal-04 hover:text-charcoal',
                        )}
                      >
                        {item.label}
                      </Link>
                    ) : (
                      <span
                        aria-disabled="true"
                        title={messages.nav.notImplemented}
                        className="block cursor-not-allowed rounded-snug px-2.5 py-1.5 text-button-sm text-charcoal-40"
                      >
                        {item.label}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="border-t border-border-warm px-3 py-space-snug">
        <JobTicker />
      </div>
    </aside>
  );
}
