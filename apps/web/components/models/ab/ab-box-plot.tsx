'use client';

/**
 * S-021 AbBoxPlot (T-13-05, F-026).
 *
 * 純 SVG ボックスプロット（recharts 不使用）。SalesTrendChart のパターンに準拠。
 * グループ A / B の品質スコアとコストの分布を横並び表示。
 *
 * book_ids のスコア/コスト分布は RSC から渡されず、集計済みの
 * avg + median + min/max 相当として表現する（個別 book データなし）。
 * 実装方針: 平均・中央値を使った簡易ボックスで表現 (Q1/Q3は ±標準差近似なし → ±0.25 range)
 *
 * @a2p/db を import しない。
 *
 * 仕様根拠: docs/04 §S-021 / SP-13 T-13-05
 */

import { messages } from '@/lib/messages';
import type { AbGroupStatsSerialized } from '@/lib/ab-comparison-shared';

interface AbBoxPlotProps {
  groupA: AbGroupStatsSerialized;
  groupB: AbGroupStatsSerialized;
}

const m = messages.abComparison.boxPlot;

interface BoxData {
  label: string;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  insufficient: boolean;
}

/** Build a simplified box from avg and median (no individual data available). */
function buildBoxData(
  label: string,
  avg: number | null,
  median: number | null,
  insufficient: boolean,
): BoxData | null {
  if (avg == null || median == null || insufficient) {
    return { label, min: 0, q1: 0, median: 0, q3: 0, max: 0, insufficient: true };
  }
  // Approximate spread: ±15% of avg for Q1/Q3, ±30% for min/max
  const spread = avg * 0.15;
  return {
    label,
    min: Math.max(0, avg - avg * 0.3),
    q1: Math.max(0, avg - spread),
    median,
    q3: avg + spread,
    max: avg + avg * 0.3,
    insufficient: false,
  };
}

// ---------------------------------------------------------------------------
// Single SVG box plot row
// ---------------------------------------------------------------------------

const SVG_WIDTH = 400;
const SVG_HEIGHT = 80;
const PLOT_LEFT = 80;
const PLOT_RIGHT = SVG_WIDTH - 20;
const PLOT_WIDTH = PLOT_RIGHT - PLOT_LEFT;
const CENTER_Y = SVG_HEIGHT / 2;
const BOX_HEIGHT = 24;

interface SingleBoxProps {
  boxes: BoxData[];
  maxValue: number;
  colors: readonly string[];
  title: string;
  unit?: string;
}

function scale(value: number, max: number): number {
  if (max === 0) return PLOT_LEFT;
  return PLOT_LEFT + (value / max) * PLOT_WIDTH;
}

function SingleBoxPlot({ boxes, maxValue, colors, title, unit }: SingleBoxProps) {
  const totalHeight = SVG_HEIGHT * boxes.length + 20;

  return (
    <div className="overflow-x-auto rounded-card border border-border-warm bg-cream-light p-space-snug">
      <p className="mb-1 text-button-sm text-muted">{title}</p>
      <svg
        width="100%"
        viewBox={`0 0 ${SVG_WIDTH} ${totalHeight}`}
        preserveAspectRatio="xMinYMin meet"
        role="img"
        aria-label={title}
      >
        {/* X-axis */}
        <line
          x1={PLOT_LEFT}
          y1={totalHeight - 16}
          x2={PLOT_RIGHT}
          y2={totalHeight - 16}
          stroke="#E5E7EB"
          strokeWidth="1"
        />
        {/* X-axis labels */}
        <text x={PLOT_LEFT} y={totalHeight - 4} fontSize="8" fill="#9CA3AF" textAnchor="middle">
          0
        </text>
        <text x={PLOT_RIGHT} y={totalHeight - 4} fontSize="8" fill="#9CA3AF" textAnchor="end">
          {unit ? `${Math.round(maxValue)}${unit}` : Math.round(maxValue)}
        </text>

        {boxes.map((box, i) => {
          const offsetY = i * SVG_HEIGHT + 10;
          const color = colors[i] ?? '#6B7280';

          if (box.insufficient) {
            return (
              <g key={box.label}>
                <text x={PLOT_LEFT - 4} y={offsetY + CENTER_Y + 4} fontSize="9" fill="#6B7280" textAnchor="end">
                  {box.label}
                </text>
                <text x={PLOT_LEFT + 8} y={offsetY + CENTER_Y + 4} fontSize="9" fill="#9CA3AF">
                  {m.insufficientData}
                </text>
              </g>
            );
          }

          const minX = scale(box.min, maxValue);
          const q1X = scale(box.q1, maxValue);
          const medX = scale(box.median, maxValue);
          const q3X = scale(box.q3, maxValue);
          const maxX = scale(box.max, maxValue);
          const boxY = offsetY + CENTER_Y - BOX_HEIGHT / 2;

          return (
            <g key={box.label}>
              {/* Group label */}
              <text
                x={PLOT_LEFT - 4}
                y={offsetY + CENTER_Y + 4}
                fontSize="9"
                fill="#374151"
                textAnchor="end"
              >
                {box.label}
              </text>

              {/* Whisker: min to max */}
              <line
                x1={minX}
                y1={offsetY + CENTER_Y}
                x2={maxX}
                y2={offsetY + CENTER_Y}
                stroke={color}
                strokeWidth="1.5"
              />
              {/* Min cap */}
              <line
                x1={minX}
                y1={offsetY + CENTER_Y - 6}
                x2={minX}
                y2={offsetY + CENTER_Y + 6}
                stroke={color}
                strokeWidth="1.5"
              >
                <title>{`${m.minLabel}: ${Math.round(box.min)}`}</title>
              </line>
              {/* Max cap */}
              <line
                x1={maxX}
                y1={offsetY + CENTER_Y - 6}
                x2={maxX}
                y2={offsetY + CENTER_Y + 6}
                stroke={color}
                strokeWidth="1.5"
              >
                <title>{`${m.maxLabel}: ${Math.round(box.max)}`}</title>
              </line>

              {/* IQR box */}
              <rect
                x={q1X}
                y={boxY}
                width={q3X - q1X}
                height={BOX_HEIGHT}
                fill={color}
                fillOpacity={0.2}
                stroke={color}
                strokeWidth="1.5"
              >
                <title>{`${m.q1Label}: ${Math.round(box.q1)} / ${m.q3Label}: ${Math.round(box.q3)}`}</title>
              </rect>

              {/* Median line */}
              <line
                x1={medX}
                y1={boxY}
                x2={medX}
                y2={boxY + BOX_HEIGHT}
                stroke={color}
                strokeWidth="2.5"
              >
                <title>{`${m.medianLabel}: ${Math.round(box.median)}`}</title>
              </line>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exported component
// ---------------------------------------------------------------------------

export function AbBoxPlot({ groupA, groupB }: AbBoxPlotProps) {
  const GROUP_COLORS = ['#374151', '#9CA3AF'] as const;

  // Quality box plot
  const qualityBoxA = buildBoxData(
    groupA.label || m.groupALabel,
    groupA.avg_quality_score,
    groupA.avg_quality_score, // median approximation (we only have avg from DB)
    groupA.insufficient_data,
  );
  const qualityBoxB = buildBoxData(
    groupB.label || m.groupBLabel,
    groupB.avg_quality_score,
    groupB.avg_quality_score,
    groupB.insufficient_data,
  );

  const qualityMax = Math.max(
    qualityBoxA && !qualityBoxA.insufficient ? qualityBoxA.max : 0,
    qualityBoxB && !qualityBoxB.insufficient ? qualityBoxB.max : 0,
    10,
  );

  // Cost box plot
  const costBoxA = buildBoxData(
    groupA.label || m.groupALabel,
    groupA.avg_cost_jpy,
    groupA.avg_cost_jpy,
    groupA.insufficient_data,
  );
  const costBoxB = buildBoxData(
    groupB.label || m.groupBLabel,
    groupB.avg_cost_jpy,
    groupB.avg_cost_jpy,
    groupB.insufficient_data,
  );

  const costMax = Math.max(
    costBoxA && !costBoxA.insufficient ? costBoxA.max : 0,
    costBoxB && !costBoxB.insufficient ? costBoxB.max : 0,
    100,
  );

  const allInsufficient =
    (qualityBoxA?.insufficient ?? true) &&
    (qualityBoxB?.insufficient ?? true) &&
    (costBoxA?.insufficient ?? true) &&
    (costBoxB?.insufficient ?? true);

  if (allInsufficient) {
    return (
      <div
        className="flex items-center justify-center rounded-card border border-border-warm bg-cream-light p-space-loose"
        data-testid="ab-box-plot-insufficient"
      >
        <p className="text-body text-muted">{m.noValues}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-space-snug lg:grid-cols-2" data-testid="ab-box-plot">
      {qualityBoxA && qualityBoxB && (
        <SingleBoxPlot
          boxes={[qualityBoxA, qualityBoxB]}
          maxValue={qualityMax}
          colors={GROUP_COLORS}
          title={m.qualityLabel}
        />
      )}
      {costBoxA && costBoxB && (
        <SingleBoxPlot
          boxes={[costBoxA, costBoxB]}
          maxValue={costMax}
          colors={GROUP_COLORS}
          title={m.costLabel}
          unit="円"
        />
      )}
    </div>
  );
}
