/**
 * `(app)` route group layout — docs/04 §3。
 *
 * 認証必須エリア共通の Header + Sidebar + Main Content シェル。
 * - S-001 ログインは `(auth)` グループに居るため本レイアウトを通らない。
 * - 認証チェックは middleware.ts が担当 (auth.config.ts callbacks.authorized)。
 */
import type { ReactNode } from 'react';
import { Header } from '@/components/layout/header';
import { Sidebar } from '@/components/layout/sidebar';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col bg-cream text-foreground">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto p-space-loose">{children}</main>
      </div>
    </div>
  );
}
