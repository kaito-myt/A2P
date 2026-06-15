'use client';

/**
 * PlansPageShell — S-005 長期出版プラン Client Shell (T-08-02).
 *
 * RSC page からシリアライズ済みデータを受け取り、
 * PlanCalendar / SeriesGraph / RegeneratePlanButton / PlanGenerationParams を組み立てる。
 */
import Link from 'next/link';

import { messages } from '@/lib/messages';
import type { PlansPageData } from '@/lib/plans-view';

import { PlanCalendar } from './plan-calendar';
import { SeriesGraph } from './series-graph';
import { RegeneratePlanButton } from './regenerate-plan-button';
import { PlanGenerationParams } from './plan-generation-params';
import { EmptyState } from '@/components/common/empty-state';
import { Button } from '@/components/ui/button';

const m = messages.plans;

interface PlansPageShellProps {
  data: PlansPageData;
}

export function PlansPageShell({ data }: PlansPageShellProps) {
  const { account, latestPlan } = data;
  const accountName = account.display_name ?? account.pen_name;

  return (
    <div className="flex flex-col gap-space-loose">
      {/* ページヘッダー */}
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
          <Link
            href={`/accounts/${account.id}`}
            className="no-underline hover:underline"
          >
            {accountName}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbPlans}</span>
        </nav>

        <div className="flex flex-col gap-space-snug md:flex-row md:items-center md:justify-between">
          <h1 className="text-sub-heading text-foreground">
            {m.pageTitle(accountName)}
          </h1>

          <RegeneratePlanButton accountId={account.id} />
        </div>
      </header>

      {/* プラン生成パラメータ (折りたたみ) */}
      <PlanGenerationParams />

      {/* メインコンテンツ */}
      {latestPlan ? (
        <div className="flex flex-col gap-space-loose">
          {/* 月別カレンダー */}
          <PlanCalendar months={latestPlan.months} accountId={account.id} />

          {/* シリーズ系統図 */}
          <SeriesGraph months={latestPlan.months} />
        </div>
      ) : (
        <EmptyState
          title={m.empty.title}
          message={m.empty.body}
          action={
            <RegeneratePlanButton accountId={account.id} />
          }
        />
      )}
    </div>
  );
}
