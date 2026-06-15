/**
 * S-008 予測コストカード (T-03-09 / T-07-10, RSC).
 *
 * `forecastBookCostJpy` の結果を表示する純表示コンポーネント。
 * - 予測総コスト / 1 冊平均 / テーマ数
 * - missingRoles があれば赤バッジ + 警告メッセージ
 * - F-036: wouldExceedMonthly=true の場合は月次超過警告を表示
 *
 * 注意: RSC (no 'use client')。インタラクション (強制続行スイッチ) は
 * BatchesPageShell 側で管理する。
 */
import { messages } from '@/lib/messages';

const m = messages.batches.forecast;
const mWarn = messages.batches.monthlyBudgetWarning;

interface CostForecastCardProps {
  themeCount: number;
  perBookJpy: number;
  totalJpy: number;
  missingRoles: readonly string[];
  catalogAvailable: boolean;
  /** F-036 月次予算レッド閾値超過予測 (T-07-10)。 */
  wouldExceedMonthly?: boolean;
}

function jpy(n: number): string {
  return `${m.jpyPrefix}${n.toLocaleString('ja-JP')}${m.jpySuffix}`;
}

export function CostForecastCard({
  themeCount,
  perBookJpy,
  totalJpy,
  missingRoles,
  catalogAvailable,
  wouldExceedMonthly = false,
}: CostForecastCardProps) {
  return (
    <section
      data-testid="cost-forecast-card"
      className="rounded-card border border-border-warm bg-cream"
    >
      <header className="px-space-loose pt-space-loose">
        <h2 className="text-card-title text-foreground">{m.sectionTitle}</h2>
      </header>
      <div className="grid gap-space-snug px-space-loose pb-space-loose pt-space-snug">
        <div className="flex items-baseline justify-between">
          <span className="text-button-sm text-muted">{m.themeCountLabel}</span>
          <span
            data-testid="forecast-theme-count"
            className="text-card-title text-foreground"
          >
            {themeCount}
            {m.themeCountSuffix}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-button-sm text-muted">{m.totalLabel}</span>
          <span
            data-testid="forecast-total-jpy"
            className="text-sub-heading text-foreground"
          >
            {jpy(totalJpy)}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-button-sm text-muted">{m.perBookLabel}</span>
          <span
            data-testid="forecast-per-book-jpy"
            className="text-button text-foreground"
          >
            {jpy(perBookJpy)}
          </span>
        </div>

        {!catalogAvailable && (
          <p
            data-testid="forecast-missing-catalog-warning"
            className="rounded-default border border-destructive bg-destructive-bg px-3 py-2 text-button-sm text-destructive"
          >
            {m.missingCatalogWarning}
          </p>
        )}
        {catalogAvailable && missingRoles.length > 0 && (
          <p
            data-testid="forecast-missing-assignment-warning"
            className="rounded-default border border-warning bg-warning-bg px-3 py-2 text-button-sm text-warning"
          >
            {m.missingAssignmentWarning}
          </p>
        )}

        {wouldExceedMonthly && (
          <div
            data-testid="forecast-monthly-budget-exceeded"
            className="flex flex-col gap-1 rounded-default border border-destructive bg-destructive-bg px-3 py-2"
          >
            <p className="text-button-sm text-destructive">{mWarn.message}</p>
            <p className="text-caption text-muted">{mWarn.forceHint}</p>
          </div>
        )}

        <p className="text-caption text-muted">{m.assumptionNote}</p>
      </div>
    </section>
  );
}
