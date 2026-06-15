'use client';

/**
 * AssignmentMatrix (S-019) — 役割 × ジャンルスロット の 7x4 マトリクス.
 *
 * 縦軸: 7 役 (writer / editor / marketer / judge / thumbnail_text /
 *              thumbnail_image / optimizer)
 * 横軸: default / 実用書 / ビジネス書 / 自己啓発 (4 列)
 *
 * 各セル: provider/model + 入出力単価 (USD per Mtok)。クリックで Drawer 開く。
 * `data-testid="assignment-cell-{role}-{genre}"` 規約。
 */
import { useRef } from 'react';

import { cn } from '@/lib/cn';
import { messages } from '@/lib/messages';
import {
  MATRIX_GENRE_SLOTS,
  MATRIX_ROLES,
  type CatalogRowSerialized,
  type MatrixCell,
} from '@/lib/model-assignments-view';
import {
  AssignmentEditorDrawer,
  type AssignmentEditorHandle,
} from './assignment-editor-drawer';

interface Props {
  cells: MatrixCell[][];
  catalog: readonly CatalogRowSerialized[];
}

export function AssignmentMatrix({ cells, catalog }: Props) {
  const m = messages.modelAssignments;
  const drawerRef = useRef<AssignmentEditorHandle | null>(null);

  function openCell(cell: MatrixCell) {
    drawerRef.current?.open({
      role: cell.role,
      genreSlot: cell.genreSlot,
      currentProvider: cell.assignment?.provider ?? null,
      currentModel: cell.assignment?.model ?? null,
    });
  }

  return (
    <section className="flex flex-col gap-space-snug">
      <header className="flex flex-col">
        <h2 className="text-card-title text-foreground">{m.matrix.sectionTitle}</h2>
        <p className="text-body text-muted">{m.matrix.sectionHint}</p>
      </header>

      <div
        data-testid="assignment-matrix"
        className="overflow-x-auto rounded-card border border-border-warm"
      >
        <table className="w-full border-collapse text-body">
          <thead className="bg-charcoal-04">
            <tr>
              <th
                scope="col"
                className="px-space-relaxed py-2 text-left text-button-sm font-normal text-charcoal-82"
              >
                {m.matrix.role}
              </th>
              {MATRIX_GENRE_SLOTS.map((slot) => (
                <th
                  key={slot}
                  scope="col"
                  className="px-space-relaxed py-2 text-left text-button-sm font-normal text-charcoal-82"
                >
                  {m.genres[slot]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cells.map((row, rIdx) => {
              const role = MATRIX_ROLES[rIdx]!;
              return (
                <tr key={role} className="border-t border-border-warm">
                  <th
                    scope="row"
                    className="bg-cream px-space-relaxed py-3 text-left text-body font-medium text-foreground"
                  >
                    {(m.roles as Record<string, string>)[role] ?? role}
                  </th>
                  {row.map((cell) => (
                    <Cell key={`${cell.role}-${cell.genreSlot}`} cell={cell} onClick={openCell} />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <AssignmentEditorDrawer ref={drawerRef} catalog={catalog} />
    </section>
  );
}

interface CellProps {
  cell: MatrixCell;
  onClick: (cell: MatrixCell) => void;
}

function Cell({ cell, onClick }: CellProps) {
  const m = messages.modelAssignments;
  const testId = `assignment-cell-${cell.role}-${cell.genreSlot}`;
  const providerLabel = cell.assignment
    ? (m.providers as Record<string, string>)[cell.assignment.provider] ??
      cell.assignment.provider
    : null;

  return (
    <td className="border-l border-border-warm p-0 align-top">
      <button
        type="button"
        data-testid={testId}
        onClick={() => onClick(cell)}
        className={cn(
          'flex h-full w-full min-w-[12rem] flex-col items-start gap-1 px-space-relaxed py-3 text-left',
          'transition-colors hover:bg-charcoal-04 focus-visible:outline-none focus-visible:bg-charcoal-04',
        )}
      >
        {cell.assignment ? (
          <>
            <span className="text-body text-foreground">
              {providerLabel} / {cell.assignment.model}
            </span>
            {cell.catalogMissing ? (
              <span className="text-button-sm text-destructive">{m.matrix.noCatalog}</span>
            ) : (
              <span className="text-button-sm text-muted">
                {m.matrix.pricePerMtok(
                  cell.inputPriceLabel ?? '—',
                  cell.outputPriceLabel ?? '—',
                )}
              </span>
            )}
          </>
        ) : (
          <span className="text-body text-muted opacity-70">{m.matrix.unset}</span>
        )}
      </button>
    </td>
  );
}
