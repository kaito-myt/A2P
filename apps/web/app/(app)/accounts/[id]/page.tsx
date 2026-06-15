/**
 * S-004 アカウント詳細・編集 (docs/04 §4 S-004 / wireframes desktop.png)。
 *
 * KDP credentials は **復号せず**、有無の boolean だけをフォームに渡す。
 * 既存値ありなら SecretField はマスク表示、「再入力」ボタンで上書き入力。
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@a2p/db';
import { AccountForm } from '@/components/accounts/account-form';
import { Button } from '@/components/ui/button';
import { messages } from '@/lib/messages';
import type { GenrePolicyValue } from '@/components/accounts/genre-policy-editor';

export const metadata: Metadata = {
  title: `${messages.accounts.detail.editPageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.accounts;

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AccountDetailPage({ params }: PageProps) {
  const { id } = await params;
  const account = await prisma.account.findUnique({ where: { id } });
  if (!account) notFound();

  const genrePolicy = normalizeGenrePolicy(account.genre_policy_json);

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
          <span>{account.pen_name}</span>
        </nav>
        <h1 className="text-sub-heading text-foreground">{m.detail.editPageTitle}</h1>
      </header>

      {/* 長期出版プランへのリンク (S-005) */}
      <div className="flex items-center justify-between rounded-card border border-border-warm bg-cream-light px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-button font-medium text-foreground">
            {m.detail.sectionPlan}
          </span>
          <span className="text-button-sm text-muted">
            {m.detail.planSummaryPlaceholder}
          </span>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href={`/accounts/${account.id}/plans`}>
            {messages.plans.link}
          </Link>
        </Button>
      </div>

      <AccountForm
        mode="edit"
        defaults={{
          id: account.id,
          pen_name: account.pen_name,
          display_name: account.display_name,
          bio: account.bio,
          target_reader: account.target_reader,
          genre_policy: genrePolicy,
          kdp_credentials_set: account.kdp_credentials_enc != null,
        }}
      />
    </div>
  );
}

function normalizeGenrePolicy(raw: unknown): GenrePolicyValue {
  const fallback: GenrePolicyValue = {
    primary_genre: 'practical',
    ratio: { practical: 0.4, business: 0.35, self_help: 0.25 },
    focus_themes: [],
  };
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Record<string, unknown>;
  const pg = r.primary_genre;
  const ratio = (r.ratio ?? {}) as Record<string, unknown>;
  const focus = Array.isArray(r.focus_themes)
    ? (r.focus_themes.filter((x): x is string => typeof x === 'string'))
    : [];
  return {
    primary_genre:
      pg === 'practical' || pg === 'business' || pg === 'self_help' ? pg : fallback.primary_genre,
    ratio: {
      practical: numOrZero(ratio.practical),
      business: numOrZero(ratio.business),
      self_help: numOrZero(ratio.self_help),
    },
    focus_themes: focus.slice(0, 20),
  };
}

function numOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
