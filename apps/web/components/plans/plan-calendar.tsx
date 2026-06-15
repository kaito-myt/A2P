'use client';

/**
 * PlanCalendar — 月別カード水平スクロール (T-08-02, S-005).
 *
 * Desktop: 横スクロール (6 枚表示)。Mobile: 縦積み。
 * 各セルの「テーマ候補を生成」CTA は generateThemes SA を呼び出し
 * テーマ一覧画面 (S-006) へ遷移する。
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight } from 'lucide-react';

import { generateThemes } from '@/app/actions/themes';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { messages } from '@/lib/messages';
import type { PlanMonthView } from '@/lib/plans-view';

const m = messages.plans;

interface PlanCalendarProps {
  months: PlanMonthView[];
  accountId: string;
}

interface MonthCellProps {
  month: PlanMonthView;
  accountId: string;
}

function MonthCell({ month, accountId }: MonthCellProps) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleGenerateThemes() {
    setIsPending(true);
    setError(null);
    try {
      // 月のカテゴリからジャンルを推測。実用書を既定として使う。
      const genre = 'practical' as const;
      const keywordOrBrief = month.theme_categories.join(' ') || month.ym;

      const result = await generateThemes({
        accountId,
        genre,
        keywordOrBrief,
        count: 10,
      });

      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      router.push('/themes');
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div
      data-testid={`plan-month-cell-${month.ym}`}
      className="flex flex-col gap-2 rounded-card border border-border-warm bg-cream-light p-4 min-w-[200px] flex-shrink-0 md:flex-1"
    >
      {/* 月ラベル */}
      <div className="text-button font-semibold text-foreground">{month.ym}</div>

      {/* 予定冊数 */}
      <div className="text-sub-heading text-charcoal">
        {m.calendar.plannedCount(month.planned_count)}
      </div>

      {/* テーマカテゴリ チップ */}
      {month.theme_categories.length > 0 && (
        <div
          aria-label={m.calendar.categoriesLabel}
          className="flex flex-wrap gap-1"
        >
          {month.theme_categories.map((cat) => (
            <Badge key={cat} variant="neutral" className="text-xs">
              {cat}
            </Badge>
          ))}
        </div>
      )}

      {/* シリーズ候補 */}
      {month.series_candidates.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-button-sm text-muted">{m.calendar.seriesCandidatesLabel}</div>
          <ul className="list-inside list-disc space-y-0.5">
            {month.series_candidates.slice(0, 3).map((c) => (
              <li key={c} className="text-button-sm text-foreground truncate">{c}</li>
            ))}
          </ul>
        </div>
      )}

      {/* エラー */}
      {error && (
        <p className="text-button-sm text-destructive">{error}</p>
      )}

      {/* CTA */}
      <div className="mt-auto pt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isPending}
          onClick={handleGenerateThemes}
          className="w-full cursor-pointer text-button-sm focus-visible:ring-2 focus-visible:ring-offset-2"
          aria-label={`${month.ym} ${m.calendar.generateThemesCta}`}
        >
          {isPending ? '生成中...' : m.calendar.generateThemesCta}
          {!isPending && <ChevronRight className="ml-1 h-3 w-3" aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}

export function PlanCalendar({ months, accountId }: PlanCalendarProps) {
  if (months.length === 0) return null;

  return (
    <section aria-label={m.calendar.sectionTitle}>
      <h2 className="mb-3 text-sub-heading text-foreground">{m.calendar.sectionTitle}</h2>
      {/* Desktop: 横スクロール / Mobile: 縦積み */}
      <div className="flex flex-col gap-3 md:flex-row md:overflow-x-auto md:pb-2">
        {months.map((month) => (
          <MonthCell key={month.ym} month={month} accountId={accountId} />
        ))}
      </div>
    </section>
  );
}
