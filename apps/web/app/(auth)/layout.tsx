import type { ReactNode } from 'react';

/**
 * (auth) ルートグループのレイアウト。
 * S-001 のみが該当し、Header/Sidebar を持たない例外 (docs/04 §S-001 設計意図メモ)。
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
