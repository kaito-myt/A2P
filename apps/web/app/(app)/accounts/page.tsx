/**
 * S-003 アカウント一覧 (docs/04 §4 S-003, docs/wireframes/S-003-accounts-list/prompt.md)。
 *
 * Phase 1 は 1 アカウント運用だが UI は複数対応構造。
 * 空状態は CTA「+ 新規アカウント追加」付き EmptyState。
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { prisma } from '@a2p/db';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/common/empty-state';
import { AccountsTable } from '@/components/accounts/accounts-table';
import { messages } from '@/lib/messages';

export const metadata: Metadata = {
  title: `${messages.accounts.listPageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.accounts;

export default async function AccountsListPage() {
  const accounts = await prisma.account.findMany({
    where: { status: 'active' },
    orderBy: { created_at: 'desc' },
  });

  return (
    <div className="flex flex-col gap-space-loose">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbAccounts}</span>
        </nav>
        <div className="flex flex-wrap items-center justify-between gap-space-snug">
          <div className="flex flex-col">
            <h1 className="text-sub-heading text-foreground">{m.listPageTitle}</h1>
            <p className="text-body text-muted">{m.listPageSubtitle}</p>
          </div>
          <Button asChild>
            <Link href="/accounts/new">{m.addAccountCta}</Link>
          </Button>
        </div>
      </header>

      {accounts.length === 0 ? (
        <EmptyState
          title={m.empty.title}
          message={m.empty.body}
          action={
            <Button asChild>
              <Link href="/accounts/new">{m.empty.cta}</Link>
            </Button>
          }
        />
      ) : (
        <AccountsTable accounts={accounts} />
      )}
    </div>
  );
}
