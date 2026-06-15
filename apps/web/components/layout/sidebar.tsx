/**
 * Sidebar — docs/04 §3.3。
 *
 * - 固定幅 240px、`bg-cream`、右端に `border-warm` 1px 縦罫線。
 * - 階層ナビ。Phase 1 で未実装の画面は disabled。
 * - 下部に JobTicker placeholder (docs/04 §6.4.7)。
 */
import Link from 'next/link';
import { navSections } from './nav-items';
import { JobTicker } from './job-ticker';
import { messages } from '@/lib/messages';
import { cn } from '@/lib/cn';

export function Sidebar() {
  return (
    <aside
      aria-label={messages.nav.sidebarAriaLabel}
      data-testid="sidebar-nav"
      className="flex h-full w-60 shrink-0 flex-col border-r border-border-warm bg-cream"
    >
      <nav className="flex-1 overflow-y-auto px-3 py-space-loose">
        {navSections.map((section) => (
          <div key={section.key} className="mb-space-relaxed last:mb-0">
            <div className="px-2 pb-1 text-button-sm text-muted">{section.label}</div>
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.key}>
                  {item.enabled ? (
                    <Link
                      href={item.href}
                      className={cn(
                        'block rounded-default px-2 py-1.5 text-button-sm text-charcoal no-underline',
                        'hover:bg-charcoal-04',
                      )}
                    >
                      {item.label}
                    </Link>
                  ) : (
                    <span
                      aria-disabled="true"
                      title={messages.nav.notImplemented}
                      className="block cursor-not-allowed rounded-default px-2 py-1.5 text-button-sm text-charcoal-40"
                    >
                      {item.label}
                    </span>
                  )}
                </li>
              ))}
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
