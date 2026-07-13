/**
 * docs/06 P4 増分2 — 販促アカウント台帳 (/org/accounts)。
 * org(account_strategist) が立案した多アカウント戦略を一覧し、pending を接続する。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';
import { kindLabel } from '@a2p/contracts/org';

import { messages } from '@/lib/messages';
import { AccountConnectForm } from '@/components/org/account-connect-form';

export const metadata: Metadata = {
  title: `${messages.org.accounts.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.org.accounts;

const STATUS_LABEL: Record<string, string> = {
  connected: m.connected,
  pending: m.pending,
  archived: m.archived,
};

export default async function OrgAccountsPage() {
  const accounts = await prisma.promotionAccount.findMany({
    orderBy: [{ status: 'asc' }, { created_at: 'desc' }],
    take: 200,
    select: {
      id: true,
      channel: true,
      handle: true,
      niche: true,
      target_reader: true,
      bio: true,
      posting_policy: true,
      status: true,
      token_mask: true,
    },
  });

  const groups: Array<{ key: string; label: string; rows: typeof accounts }> = [
    { key: 'pending', label: m.pending, rows: accounts.filter((a) => a.status === 'pending') },
    { key: 'connected', label: m.connected, rows: accounts.filter((a) => a.status === 'connected') },
    { key: 'archived', label: m.archived, rows: accounts.filter((a) => a.status === 'archived') },
  ];

  return (
    <div className="flex flex-col gap-space-loose" data-testid="org-accounts-page">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">ホーム</Link>
          <span aria-hidden="true"> &gt; </span>
          <Link href="/org" className="no-underline hover:underline">{messages.org.dashboard.pageTitle}</Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.pageTitle}</span>
        </nav>
        <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
        <p className="text-body text-muted">{m.pageSubtitle}</p>
      </header>

      {accounts.length === 0 && <p className="text-body text-muted" data-testid="org-accounts-empty">{m.empty}</p>}

      {groups.map((g) =>
        g.rows.length === 0 ? null : (
          <section key={g.key} className="flex flex-col gap-space-snug">
            <h2 className="text-body-emphasis text-foreground">
              {g.label} <span className="text-caption text-muted">({g.rows.length})</span>
            </h2>
            <div className="flex flex-col gap-space-snug">
              {g.rows.map((a) => (
                <article key={a.id} className="flex flex-col gap-2 rounded-card border border-line p-4" data-testid={`org-account-${a.id}`}>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="rounded-full bg-charcoal px-2 py-0.5 text-caption text-cream-light">{a.channel}</span>
                    <span className="text-body-emphasis text-foreground">{a.niche}</span>
                    <span className="text-caption text-muted">{STATUS_LABEL[a.status] ?? a.status}</span>
                    {a.handle && <span className="text-caption text-muted">{a.handle}</span>}
                    {a.token_mask && <span className="text-caption text-success">🔑 {a.token_mask}</span>}
                  </div>
                  {a.target_reader && <p className="text-caption text-muted">{m.target}: {a.target_reader}</p>}
                  {a.bio && <p className="text-caption text-muted whitespace-pre-wrap">{m.bio}: {a.bio}</p>}
                  {a.posting_policy && <p className="text-caption text-muted whitespace-pre-wrap">{m.postingPolicy}: {a.posting_policy}</p>}
                  {a.status !== 'archived' && <AccountConnectForm accountId={a.id} channel={a.channel} />}
                </article>
              ))}
            </div>
          </section>
        ),
      )}
      <p className="text-caption text-muted">{kindLabel('create_account')}は全社ToDoに要人手タスクとして起票されます。</p>
    </div>
  );
}
