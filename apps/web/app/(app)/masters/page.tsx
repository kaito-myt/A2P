/**
 * 著者名・レーベル名マスタ管理ページ。
 *
 * テーマ作成時にプルダウンで選択する著者名 / レーベル名を登録・管理する。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import { MastersManager } from '@/components/masters/masters-manager';

export const metadata: Metadata = {
  title: `${messages.masters.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.masters;

export default async function MastersPage() {
  const [authors, labels] = await Promise.all([
    prisma.authorName.findMany({
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        name_kana: true,
        name_romaji: true,
        note: true,
        status: true,
      },
    }),
    prisma.labelName.findMany({
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, note: true, status: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-space-loose" data-testid="masters-page">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbOps}</span>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.pageTitle}</span>
        </nav>
        <div className="flex flex-col">
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
      </header>

      <MastersManager authors={authors} labels={labels} />
    </div>
  );
}
