'use client';

/**
 * S-017 SalesTrendChart (T-08-07, F-039).
 *
 * 月次積み上げ棒グラフ — HTML/SVG ベース (recharts なし, Phase 1 決定)。
 * ジャンルはパターン + 色で区別 (色のみに依存しないアクセシビリティ対応)。
 *
 * 仕様根拠: docs/04 S-017 / SP-08 T-08-07 / wireframe 注記 "グラフは枠 + 簡易折線/棒の輪郭で表現"
 */

import type { ReactElement } from 'react';
import { messages } from '@/lib/messages';
import type { TrendChartMonth } from '@/lib/sales-kpi-view';

interface SalesTrendChartProps {
  data: TrendChartMonth[];
}

const m = messages.salesKpi.trendChart;

const GENRES = [
  { key: 'practical', color: '#6B7280', pattern: 'url(#diag-practical)' },
  { key: 'business', color: '#374151', pattern: 'url(#diag-business)' },
  { key: 'self_help', color: '#9CA3AF', pattern: 'url(#diag-selfhelp)' },
] as const;

type GenreKey = 'practical' | 'business' | 'self_help';

const CHART_HEIGHT = 200;
const BAR_GAP = 4;

function formatYen(v: number): string {
  if (v >= 100_000) return `¥${Math.round(v / 10_000)}万`;
  if (v >= 1_000) return `¥${(v / 1_000).toFixed(0)}k`;
  return `¥${v}`;
}

export function SalesTrendChart({ data }: SalesTrendChartProps) {
  const isEmpty = data.every((d) => d.total === 0);
  const maxValue = Math.max(...data.map((d) => d.total), 1);

  return (
    <section
      aria-labelledby="trend-chart-heading"
      className="flex flex-col gap-space-snug"
      data-testid="sales-trend-chart"
    >
      <h2 id="trend-chart-heading" className="text-card-title text-foreground">
        {m.sectionTitle}
      </h2>

      {/* Legend — genre by color + pattern */}
      <div className="flex flex-wrap gap-space-snug">
        {GENRES.map((g) => (
          <div key={g.key} className="flex items-center gap-1.5">
            <span
              className="inline-block h-3 w-4 shrink-0 border border-charcoal-20"
              style={{ backgroundColor: g.color }}
              aria-hidden="true"
            />
            <span className="text-button-sm text-muted">
              {m.genreLabels[g.key as keyof typeof m.genreLabels]}
            </span>
          </div>
        ))}
      </div>

      {isEmpty ? (
        <div className="flex h-40 items-center justify-center rounded-card border border-border-warm bg-cream-light">
          <p className="text-body text-muted">{m.empty}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border-warm bg-cream-light p-space-snug">
          {/* Screen-reader summary */}
          <p className="sr-only">
            {m.ariaDescription(data.length, formatYen(maxValue))}
          </p>
          <svg
            width="100%"
            viewBox={`0 0 ${Math.max(data.length * 40, 320)} ${CHART_HEIGHT + 30}`}
            preserveAspectRatio="xMinYMin meet"
            role="img"
            aria-labelledby="trend-chart-heading"
          >
            <defs>
              {/* Diagonal line pattern for practical */}
              <pattern id="diag-practical" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="4" stroke="#fff" strokeWidth="1.5" />
              </pattern>
              {/* Crosshatch for business */}
              <pattern id="diag-business" patternUnits="userSpaceOnUse" width="4" height="4">
                <line x1="0" y1="2" x2="4" y2="2" stroke="#fff" strokeWidth="1" />
                <line x1="2" y1="0" x2="2" y2="4" stroke="#fff" strokeWidth="1" />
              </pattern>
              {/* Horizontal lines for self_help */}
              <pattern id="diag-selfhelp" patternUnits="userSpaceOnUse" width="4" height="4">
                <line x1="0" y1="2" x2="4" y2="2" stroke="#fff" strokeWidth="1" />
              </pattern>
            </defs>

            {data.map((month, i) => {
              const barWidth = Math.max(20, (320 / data.length) - BAR_GAP);
              const x = i * (barWidth + BAR_GAP) + BAR_GAP;
              let yOffset = CHART_HEIGHT;
              const bars: ReactElement[] = [];

              for (const genre of [...GENRES].reverse()) {
                const val = month[genre.key as GenreKey];
                if (val <= 0) continue;
                const barH = (val / maxValue) * (CHART_HEIGHT - 20);
                yOffset -= barH;
                const label = `${month.ym} ${m.genreLabels[genre.key as keyof typeof m.genreLabels]}: ${formatYen(val)}`;
                bars.push(
                  <g key={genre.key}>
                    <rect
                      x={x}
                      y={yOffset}
                      width={barWidth}
                      height={barH}
                      fill={genre.color}
                      stroke="white"
                      strokeWidth="0.5"
                    >
                      <title>{label}</title>
                    </rect>
                    <rect
                      x={x}
                      y={yOffset}
                      width={barWidth}
                      height={barH}
                      fill={genre.pattern}
                      stroke="none"
                      aria-label={label}
                    />
                  </g>,
                );
              }

              const ymShort = month.ym.slice(5); // "MM"

              return (
                <g key={month.ym}>
                  {bars}
                  <text
                    x={x + barWidth / 2}
                    y={CHART_HEIGHT + 14}
                    textAnchor="middle"
                    fontSize="9"
                    fill="#6B7280"
                  >
                    {ymShort}
                  </text>
                </g>
              );
            })}

            {/* Y-axis label */}
            <text
              x={2}
              y={8}
              fontSize="8"
              fill="#9CA3AF"
            >
              {formatYen(maxValue)}
            </text>
            <line
              x1={0}
              y1={CHART_HEIGHT}
              x2={Math.max(data.length * 44, 320)}
              y2={CHART_HEIGHT}
              stroke="#E5E7EB"
              strokeWidth="1"
            />
          </svg>
        </div>
      )}
    </section>
  );
}
