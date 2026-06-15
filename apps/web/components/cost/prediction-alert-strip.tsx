/**
 * S-024 PredictionAlertStrip (T-07-05).
 *
 * 80/95/100% threshold bar with color indicators.
 */
import { cn } from '@/lib/cn';
import { messages } from '@/lib/messages';
import { type PredictionLevel } from '@/lib/cost-dashboard-view';

interface PredictionAlertStripProps {
  ratioPct: number;
  forecastRatioPct: number;
  level: PredictionLevel;
}

const m = messages.costDashboard.prediction;

const levelStyles: Record<PredictionLevel, { bg: string; text: string; label: string }> = {
  safe: { bg: 'bg-success-bg', text: 'text-success', label: m.statusSafe },
  yellow: { bg: 'bg-warning-bg', text: 'text-warning', label: m.statusYellow },
  orange: { bg: 'bg-[#FFF3E0]', text: 'text-[#E65100]', label: m.statusOrange },
  red: { bg: 'bg-destructive-bg', text: 'text-destructive', label: m.statusRed },
};

export function PredictionAlertStrip({ ratioPct, forecastRatioPct, level }: PredictionAlertStripProps) {
  const style = levelStyles[level];
  const barWidth = Math.min(ratioPct, 100);

  return (
    <div
      className={cn('rounded-card border border-border-warm p-space-loose', style.bg)}
      data-testid="prediction-alert-strip"
    >
      <div className="mb-space-snug flex items-center justify-between">
        <h3 className="text-card-title text-charcoal">{m.sectionTitle}</h3>
        <span className={cn('text-button-sm font-medium', style.text)} data-testid="prediction-status">
          {style.label}
        </span>
      </div>

      <div className="mb-space-snug">
        <div className="relative h-4 w-full overflow-hidden rounded-pill bg-charcoal-04">
          <div
            className={cn(
              'absolute left-0 top-0 h-full rounded-pill transition-all',
              level === 'safe' && 'bg-success',
              level === 'yellow' && 'bg-warning',
              level === 'orange' && 'bg-[#E65100]',
              level === 'red' && 'bg-destructive',
            )}
            style={{ width: `${barWidth}%` }}
            data-testid="prediction-bar"
          />

          <div className="absolute left-[80%] top-0 h-full w-px bg-charcoal-20" aria-hidden="true" />
          <div className="absolute left-[95%] top-0 h-full w-px bg-charcoal-20" aria-hidden="true" />
          <div className="absolute left-[100%] top-0 h-full w-px bg-charcoal" aria-hidden="true" />
        </div>
      </div>

      <div className="flex flex-wrap gap-space-loose text-caption text-muted">
        <ThresholdLabel label={m.thresholdYellow} active={ratioPct >= 80} />
        <ThresholdLabel label={m.thresholdOrange} active={ratioPct >= 95} />
        <ThresholdLabel label={m.thresholdRed} active={ratioPct >= 100} />
      </div>

      {forecastRatioPct > 0 && (
        <p className="mt-space-snug text-caption text-muted" data-testid="forecast-ratio">
          {`月末予測: ${Math.round(forecastRatioPct * 10) / 10}%`}
        </p>
      )}
    </div>
  );
}

function ThresholdLabel({ label, active }: { label: string; active: boolean }) {
  return (
    <span className={cn('text-caption', active ? 'font-medium text-charcoal' : 'text-muted')}>
      {label}
    </span>
  );
}
