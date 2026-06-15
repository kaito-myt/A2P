/**
 * S-021 モデル A/B 比較ビュー RSC ページ (T-13-04, F-026).
 *
 * searchParams から AbComparisonFilter を構築し、fetchAbComparisonView で
 * 集計データを取得して AbComparisonShell に渡す。
 *
 * クライアントコンポーネントには @a2p/db 型を渡さない（シリアライズ済み純粋型のみ）。
 * 仕様根拠: docs/04 §S-021 / SP-13 T-13-04 / CLAUDE.md client/server 境界
 */

import type { Metadata } from 'next';
import Link from 'next/link';

import { messages } from '@/lib/messages';
import {
  buildFilterFromSearchParams,
  fetchAbComparisonView,
} from '@/lib/ab-comparison-view';
import { buildFilterSerializedFromSearchParams } from '@/lib/ab-comparison-shared';
import { AbComparisonShell } from '@/components/models/ab/ab-comparison-shell';
import { getSessionOrThrow } from '@/lib/auth-helpers';

export const metadata: Metadata = {
  title: `${messages.abComparison.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.abComparison;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AbComparisonPage({ searchParams }: PageProps) {
  await getSessionOrThrow();

  const params = await searchParams;

  // Server-side filter (Date objects) for DB query
  const filter = buildFilterFromSearchParams(params);
  // Client-safe filter (ISO strings) to pass to shell
  const filterSerialized = buildFilterSerializedFromSearchParams(params);

  const result = await fetchAbComparisonView(filter);

  return (
    <div className="flex flex-col gap-space-loose" data-testid="ab-comparison-page">
      {/* Page header */}
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbModels}</span>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbAbCompare}</span>
        </nav>
        <div>
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
      </header>

      <AbComparisonShell result={result} filter={filterSerialized} />
    </div>
  );
}
