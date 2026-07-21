'use client';

/**
 * GlobalProgressBar — S-014 全体進捗バー (T-06-09).
 *
 * Shows n/m comments processed as a visual bar + percentage.
 * - バー色は状態連動 (実行中=accent / 完了=success緑 / 一部失敗=warning / 失敗=destructive)。
 * - マウント時に 0 → 実値へアニメートし、瞬時に 100% へ「飛ぶ」ジャンクを避ける。
 */
import { useEffect, useState } from 'react';

import { messages } from '@/lib/messages';
import type { RunProgress, RunStatus } from '@/lib/revision-runs-view';

const m = messages.revisionRuns.progress;

interface GlobalProgressBarProps {
  progress: RunProgress;
  status: RunStatus;
}

function fillClass(status: RunStatus): string {
  switch (status) {
    case 'done':
    case 'partial':
      return 'bg-success';
    case 'failed':
      return 'bg-destructive';
    default:
      // queued / running
      return 'bg-accent';
  }
}

export function GlobalProgressBar({ progress, status }: GlobalProgressBarProps) {
  const processed = progress.applied + progress.not_applicable;
  const isComplete = status === 'done' || status === 'partial';
  const isRunning = status === 'queued' || status === 'running';

  // マウント直後は 0 から実値へアニメート (transition で滑らかに伸びる)。
  const [shownPercent, setShownPercent] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShownPercent(Math.min(progress.percent, 100)));
    return () => cancelAnimationFrame(id);
  }, [progress.percent]);

  return (
    <div data-testid="global-progress-bar" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-button-sm">
        <span className="font-medium text-charcoal">
          {m.processed(processed, progress.total)} {m.percent(progress.percent)}
        </span>
        {isComplete && <span className="text-success">{m.complete}</span>}
        {isRunning && <span className="text-accent">{m.running}</span>}
      </div>

      <div className="relative h-3 w-full overflow-hidden rounded-pill bg-charcoal-04">
        <div
          className={`h-full rounded-pill transition-[width] duration-700 ease-out ${fillClass(status)} ${isRunning ? 'animate-pulse' : ''}`}
          style={{ width: `${shownPercent}%` }}
          data-testid="progress-bar-fill"
        />
      </div>
    </div>
  );
}
