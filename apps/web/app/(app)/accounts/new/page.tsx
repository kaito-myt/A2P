/**
 * S-004 新規アカウント追加 (docs/04 §4 S-004 / wireframes empty.png)。
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { AccountForm } from '@/components/accounts/account-form';
import { messages } from '@/lib/messages';

export const metadata: Metadata = {
  title: `${messages.accounts.detail.newPageTitle} | ${messages.brand.appName}`,
};

const m = messages.accounts;

export default function NewAccountPage() {
  return (
    <div className="flex flex-col gap-space-loose">
      <header className="flex flex-col gap-1">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <Link href="/accounts" className="no-underline hover:underline">
            {m.breadcrumbAccounts}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.detail.newPageTitle}</span>
        </nav>
        <h1 className="text-sub-heading text-foreground">{m.detail.newPageTitle}</h1>
      </header>

      <AccountForm mode="create" defaults={{ kdp_credentials_set: false }} />
    </div>
  );
}
