'use client';

/**
 * S-021 AbComparisonShell (T-13-05, F-026).
 *
 * ページ全体のクライアントシェル。フォーム・KPI カード・ボックスプロット・書籍リストを配置する。
 * @a2p/db は import しない — 純粋型 AbComparisonResultSerialized のみ使う。
 *
 * 仕様根拠: docs/04 §S-021 / SP-13 T-13-05 / CLAUDE.md client/server 境界
 */

import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { messages } from '@/lib/messages';
import type {
  AbComparisonFilterSerialized,
  AbComparisonResultSerialized,
} from '@/lib/ab-comparison-shared';
import { ComparisonForm } from './comparison-form';
import { ComparisonKpiCards } from './comparison-kpi-cards';
import { AbBoxPlot } from './ab-box-plot';
import { BookListPerGroup } from './book-list-per-group';

interface AbComparisonShellProps {
  result: AbComparisonResultSerialized;
  filter: AbComparisonFilterSerialized;
}

const m = messages.abComparison;

export function AbComparisonShell({ result, filter }: AbComparisonShellProps) {
  const router = useRouter();

  const bothInsufficient = result.group_a.insufficient_data && result.group_b.insufficient_data;

  function handleFilterChange(newFilter: AbComparisonFilterSerialized) {
    const params = new URLSearchParams();
    params.set('mode', newFilter.mode);

    if (newFilter.mode === 'period') {
      if (newFilter.periodA) {
        params.set('dateFromA', newFilter.periodA.from);
        params.set('dateToA', newFilter.periodA.to);
      }
      if (newFilter.periodB) {
        params.set('dateFromB', newFilter.periodB.from);
        params.set('dateToB', newFilter.periodB.to);
      }
    } else {
      if (newFilter.role) params.set('role', newFilter.role);
      if (newFilter.baselineId) params.set('baselineId', newFilter.baselineId);
      if (newFilter.candidateId) params.set('candidateId', newFilter.candidateId);
    }

    if (newFilter.minSample != null) {
      params.set('minSample', String(newFilter.minSample));
    }

    router.push(`/models/ab?${params.toString()}`);
  }

  return (
    <div className="flex flex-col gap-space-loose" data-testid="ab-comparison-shell">
      {/* 比較設定フォーム */}
      <section aria-labelledby="ab-form-heading" data-testid="ab-comparison-form-section">
        <h2 id="ab-form-heading" className="mb-space-snug text-card-title text-foreground">
          {m.form.sectionTitle}
        </h2>
        <ComparisonForm filter={filter} onSubmit={handleFilterChange} />
      </section>

      {/* サンプル数表示 */}
      <section aria-labelledby="ab-sample-heading" data-testid="ab-sample-count-section">
        <h2 id="ab-sample-heading" className="mb-space-snug text-card-title text-foreground">
          {m.sampleCount.sectionTitle}
        </h2>
        <div className="grid grid-cols-1 gap-space-snug sm:grid-cols-2">
          <SampleCountCard
            label={result.group_a.label || m.sampleCount.groupALabel}
            count={result.group_a.book_count}
            insufficient={result.group_a.insufficient_data}
            testId="ab-sample-count-a"
          />
          <SampleCountCard
            label={result.group_b.label || m.sampleCount.groupBLabel}
            count={result.group_b.book_count}
            insufficient={result.group_b.insufficient_data}
            testId="ab-sample-count-b"
          />
        </div>
      </section>

      {/* 両グループとも不足の場合: 空状態 */}
      {bothInsufficient ? (
        <div
          className="flex flex-col items-center gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
          data-testid="ab-both-insufficient"
        >
          <p className="text-body font-medium text-charcoal">{m.bothInsufficient.title}</p>
          <p className="text-body text-muted">{m.bothInsufficient.body}</p>
          <p className="text-caption text-muted">{m.bothInsufficient.subBody}</p>
          <Link
            href="/dashboard"
            className="mt-2 inline-flex cursor-pointer items-center rounded-card bg-charcoal px-4 py-2 text-button-sm text-white hover:bg-charcoal/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="ab-insufficient-home-cta"
          >
            {m.bothInsufficient.cta}
          </Link>
        </div>
      ) : (
        <>
          {/* KPI カード */}
          <section aria-labelledby="ab-kpi-heading" data-testid="ab-kpi-section">
            <h2 id="ab-kpi-heading" className="mb-space-snug text-card-title text-foreground">
              {m.kpi.sectionTitle}
            </h2>
            <ComparisonKpiCards groupA={result.group_a} groupB={result.group_b} />
          </section>

          {/* ボックスプロット */}
          <section aria-labelledby="ab-plot-heading" data-testid="ab-box-plot-section">
            <h2 id="ab-plot-heading" className="mb-space-snug text-card-title text-foreground">
              {m.boxPlot.sectionTitle}
            </h2>
            <AbBoxPlot groupA={result.group_a} groupB={result.group_b} />
          </section>

          {/* 書籍リスト */}
          <section aria-labelledby="ab-books-heading" data-testid="ab-book-list-section">
            <h2 id="ab-books-heading" className="mb-space-snug text-card-title text-foreground">
              {m.bookList.sectionTitle}
            </h2>
            <BookListPerGroup groupA={result.group_a} groupB={result.group_b} />
          </section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Internal: sample count card
// ---------------------------------------------------------------------------

interface SampleCountCardProps {
  label: string;
  count: number;
  insufficient: boolean;
  testId: string;
}

function SampleCountCard({ label, count, insufficient, testId }: SampleCountCardProps) {
  const m2 = messages.abComparison.sampleCount;
  return (
    <div
      className={`rounded-card border p-space-snug ${insufficient ? 'border-red-300 bg-red-50' : 'border-border-warm bg-cream-light'}`}
      data-testid={testId}
    >
      <p className="text-button-sm text-muted">{label}</p>
      <p className="mt-1 text-sub-heading text-foreground">
        {count} {m2.bookCountSuffix}
      </p>
      {insufficient ? (
        <p className="mt-1 text-caption text-red-600" data-testid={`${testId}-insufficient`}>
          {m2.insufficient}
        </p>
      ) : (
        <p className="mt-1 text-caption text-green-700">{m2.sufficient}</p>
      )}
    </div>
  );
}
