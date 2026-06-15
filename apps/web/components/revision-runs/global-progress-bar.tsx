'use client';

/**
 * GlobalProgressBar — S-014 全体進捗バー (T-06-09).
 *
 * Shows n/m comments processed as a visual bar + percentage.
 */
import { messages } from '@/lib/messages';
import type { RunProgress, RunStatus } from '@/lib/revision-runs-view';

const m = messages.revisionRuns.progress;

interface GlobalProgressBarProps {
  progress: RunProgress;
  status: RunStatus;
}

export function GlobalProgressBar({ progress, status }: GlobalProgressBarProps) {
  const processed = progress.applied + progress.not_applicable;
  const isComplete = status === 'done' || status === 'partial';

  return (
    <div data-testid="global-progress-bar" className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-button-sm">
        <span className="font-medium text-charcoal">
          {m.processed(processed, progress.total)} {m.percent(progress.percent)}
        </span>
        {isComplete && (
          <span className="text-muted">{m.complete}</span>
        )}
      </div>

      <div className="relative h-3 w-full rounded-pill bg-charcoal-04">
        <div
          className="h-full rounded-pill bg-foreground transition-all duration-300"
          style={{ width: `${Math.min(progress.percent, 100)}%` }}
          data-testid="progress-bar-fill"
        />
      </div>
    </div>
  );
}
