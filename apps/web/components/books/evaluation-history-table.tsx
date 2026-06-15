'use client';

/**
 * S-010 評価履歴タブ本実装 (T-10-06).
 *
 * 列: judged_at | score_total | 6 軸スコア | triggered_by | judge_comments (accordion)
 * - 最新行に "latest" バッジ
 * - score_total < 80 の行は赤ハイライト
 * - triggered_by が 'revision_run:*' の場合は修正反映詳細へのリンク
 */
import { useState } from 'react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { messages } from '@/lib/messages';
import {
  SCORE_AXES,
  SCORE_LOW_THRESHOLD,
  formatScoreAxis,
  isLowScore,
  parseTriggeredBy,
  type EvalResultSerialized,
} from '@/lib/eval-history-view';
import { formatDateTime } from '@/lib/books-view';

const m = messages.books.evaluation;

// ---------------------------------------------------------------------------
// Mini score bar (0..100 per axis, rendered as inline bar)
// ---------------------------------------------------------------------------

function ScoreBar({ value, max = 100 }: { value: number | undefined; max?: number }) {
  const pct = value != null ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative h-1.5 w-12 rounded-pill bg-charcoal-04">
        <div
          className="h-full rounded-pill bg-foreground"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-caption text-muted w-6 text-right">
        {value != null ? value : '—'}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Comments accordion (inline per row)
// ---------------------------------------------------------------------------

function CommentsAccordion({ comments }: { comments: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(comments);

  if (entries.length === 0) return <span className="text-caption text-muted">—</span>;

  return (
    <div>
      <button
        type="button"
        className="text-button-sm text-accent underline hover:no-underline"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? m.commentsCollapse : m.commentsExpand}
      </button>
      {open && (
        <dl className="mt-1 space-y-1 text-caption">
          {entries.map(([axis, comment]) => (
            <div key={axis}>
              <dt className="font-medium text-charcoal-82">{formatScoreAxis(axis)}</dt>
              <dd className="text-muted ml-2">{comment}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Triggered-by cell
// ---------------------------------------------------------------------------

function TriggeredByCell({ triggered_by }: { triggered_by: string }) {
  const { label, revisionRunId } = parseTriggeredBy(triggered_by);

  if (revisionRunId) {
    return (
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        <Link
          href={`/revision-runs/${revisionRunId}`}
          className="text-caption text-accent underline hover:no-underline"
        >
          {m.revisionRunLink}
        </Link>
      </span>
    );
  }

  return <span>{label}</span>;
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div
      className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
      data-testid="eval-history-empty"
    >
      <p className="text-body text-muted">{m.noHistory}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EvaluationHistoryTable (main export)
// ---------------------------------------------------------------------------

interface EvaluationHistoryTableProps {
  results: EvalResultSerialized[];
}

export function EvaluationHistoryTable({ results }: EvaluationHistoryTableProps) {
  if (results.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="overflow-x-auto" data-testid="eval-history-table">
      <table className="w-full text-body">
        <thead>
          <tr className="border-b border-border-warm text-left text-caption text-muted">
            <th className="px-2 py-1.5">{m.colJudgedAt}</th>
            <th className="px-2 py-1.5">{m.colScoreTotal}</th>
            <th className="px-2 py-1.5">{m.colScoreBreakdown}</th>
            <th className="px-2 py-1.5">{m.colTriggeredBy}</th>
            <th className="px-2 py-1.5">{m.colComments}</th>
          </tr>
        </thead>
        <tbody>
          {results.map((result, index) => {
            const low = isLowScore(result.score_total);
            const isLatest = index === 0;

            return (
              <tr
                key={result.id}
                className={[
                  'border-b border-border-warm last:border-b-0',
                  low ? 'bg-destructive-bg' : '',
                ].join(' ')}
                data-testid={`eval-row-${result.id}`}
                data-low-score={low ? 'true' : undefined}
              >
                {/* judged_at */}
                <td className="px-2 py-2 whitespace-nowrap">
                  <span className="flex items-center gap-1.5">
                    {formatDateTime(result.judged_at)}
                    {isLatest && (
                      <Badge variant="neutral" data-testid="eval-latest-badge">
                        {m.latestBadge}
                      </Badge>
                    )}
                  </span>
                </td>

                {/* score_total */}
                <td className="px-2 py-2">
                  <span
                    className={[
                      'font-medium',
                      low ? 'text-destructive' : 'text-foreground',
                    ].join(' ')}
                    data-testid={low ? 'eval-score-low' : 'eval-score-ok'}
                  >
                    {result.score_total}
                  </span>
                  <span className="text-caption text-muted"> / 100</span>
                </td>

                {/* 6-axis breakdown */}
                <td className="px-2 py-2">
                  <div className="space-y-0.5">
                    {SCORE_AXES.map((axis) => (
                      <div key={axis} className="flex items-center gap-2">
                        <span className="w-20 text-caption text-muted truncate">
                          {formatScoreAxis(axis)}
                        </span>
                        <ScoreBar value={result.score_breakdown[axis]} />
                      </div>
                    ))}
                  </div>
                </td>

                {/* triggered_by */}
                <td className="px-2 py-2 text-body">
                  <TriggeredByCell triggered_by={result.triggered_by} />
                </td>

                {/* judge_comments accordion */}
                <td className="px-2 py-2 max-w-xs">
                  <CommentsAccordion comments={result.judge_comments} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
