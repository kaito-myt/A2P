'use client';

/**
 * S-017 GenreMonthHeatmap (T-08-07, F-039).
 *
 * 3ジャンル × Nヶ月 のヒートマップ。セル濃淡で売上量を表現。
 * 色のみに依存しないアクセシビリティ: title / aria-label にテキスト値。
 * 凡例 + テキスト値 (小さいがホバーで全表示)。
 *
 * 仕様根拠: docs/04 S-017 / SP-08 T-08-07 (色のみ依存しない)
 */

import { Fragment } from 'react';
import { messages } from '@/lib/messages';
import { formatJpy, type HeatmapMatrix } from '@/lib/sales-kpi-view';

interface GenreMonthHeatmapProps {
  matrix: HeatmapMatrix;
}

const m = messages.salesKpi.heatmap;

/** Get cell by genre + ym */
function getCell(cells: HeatmapMatrix['cells'], genre: string, ym: string) {
  return cells.find((c) => c.genre === genre && c.ym === ym);
}

/** HSL colour – warm amber tones matching the app palette */
function cellBg(intensity: number): string {
  if (intensity === 0) return 'hsl(40, 20%, 95%)'; // near-white cream
  const lightness = Math.round(95 - intensity * 55); // 95 → 40
  return `hsl(30, 60%, ${lightness}%)`;
}

function cellFg(intensity: number): string {
  return intensity > 0.55 ? '#fff' : '#374151';
}

export function GenreMonthHeatmap({ matrix }: GenreMonthHeatmapProps) {
  const isEmpty = matrix.maxValue === 0;
  const genreLabels = m.genreLabels;

  return (
    <section
      aria-labelledby="heatmap-heading"
      className="flex flex-col gap-space-snug"
      data-testid="genre-month-heatmap"
    >
      <h2 id="heatmap-heading" className="text-card-title text-foreground">
        {m.sectionTitle}
      </h2>

      {isEmpty ? (
        <div className="flex h-40 items-center justify-center rounded-card border border-border-warm bg-cream-light">
          <p className="text-body text-muted">{m.empty}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border-warm bg-cream-light p-space-snug">
          {/* SR summary table */}
          <table
            className="sr-only"
            aria-label={m.ariaTableLabel}
          >
            <thead>
              <tr>
                <th scope="col">{m.colGenre}</th>
                {matrix.months.map((ym) => (
                  <th key={ym} scope="col">{ym}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.genres.map((genre) => (
                <tr key={genre}>
                  <th scope="row">{genreLabels[genre as keyof typeof genreLabels] ?? genre}</th>
                  {matrix.months.map((ym) => {
                    const cell = getCell(matrix.cells, genre, ym);
                    return (
                      <td key={ym}>{formatJpy(cell?.value ?? 0)}</td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          {/* Visual heatmap grid */}
          <div
            className="grid gap-0.5"
            style={{
              gridTemplateColumns: `auto repeat(${matrix.months.length}, minmax(28px, 1fr))`,
            }}
            aria-hidden="true"
          >
            {/* Header row */}
            <div />
            {matrix.months.map((ym) => (
              <div
                key={ym}
                className="text-center text-caption text-muted"
                style={{ fontSize: '9px' }}
              >
                {ym.slice(5)}
              </div>
            ))}

            {/* Data rows */}
            {matrix.genres.map((genre) => (
              <Fragment key={genre}>
                <div
                  className="flex items-center pr-1 text-button-sm text-muted"
                  style={{ fontSize: '10px', whiteSpace: 'nowrap' }}
                >
                  {genreLabels[genre as keyof typeof genreLabels] ?? genre}
                </div>
                {matrix.months.map((ym) => {
                  const cell = getCell(matrix.cells, genre, ym);
                  const intensity = cell?.intensity ?? 0;
                  const value = cell?.value ?? 0;
                  const label = `${genreLabels[genre as keyof typeof genreLabels] ?? genre} ${ym}: ${formatJpy(value)}`;

                  return (
                    <div
                      key={`${genre}-${ym}`}
                      className="flex items-center justify-center rounded-sm border border-border-warm"
                      style={{
                        backgroundColor: cellBg(intensity),
                        color: cellFg(intensity),
                        height: '28px',
                        fontSize: '8px',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                      title={label}
                      aria-label={label}
                    >
                      {value > 0 ? formatJpy(value) : ''}
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>

          {/* Legend scale */}
          <div className="mt-2 flex items-center gap-2">
            <span className="text-caption text-muted" style={{ fontSize: '9px' }}>
              {m.legendLow}
            </span>
            <div
              className="h-3 w-24 rounded-sm border border-border-warm"
              style={{
                background: 'linear-gradient(to right, hsl(40,20%,95%), hsl(30,60%,40%))',
              }}
              aria-hidden="true"
            />
            <span className="text-caption text-muted" style={{ fontSize: '9px' }}>
              {m.legendHigh} ({formatJpy(matrix.maxValue)})
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
