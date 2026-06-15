/**
 * S-025 JobStatsCard (T-09-01, F-045).
 *
 * 3 枚の統計カード: 直近 24h 成功率 / 平均実行時間 / 失敗件数。
 *
 * 仕様根拠: docs/04 S-025 / SP-09 T-09-01
 */
import { Card, CardContent } from '@/components/ui/card';
import { messages } from '@/lib/messages';
import { formatAvgDuration, type JobStats } from '@/lib/jobs-view';

interface JobStatsCardProps {
  stats: JobStats;
}

const m = messages.jobs.stats;

export function JobStatsCards({ stats }: JobStatsCardProps) {
  return (
    <div
      className="grid grid-cols-1 gap-space-snug sm:grid-cols-3"
      data-testid="job-stats-cards"
    >
      <StatCard
        label={m.successRateLabel}
        value={`${stats.success_rate_pct}${m.successRateSuffix}`}
        testId="job-stat-success-rate"
      />
      <StatCard
        label={m.avgDurationLabel}
        value={formatAvgDuration(stats.avg_duration_ms)}
        testId="job-stat-avg-duration"
      />
      <StatCard
        label={m.failedCountLabel}
        value={`${stats.failed_count.toLocaleString('ja-JP')}${m.failedCountSuffix}`}
        testId="job-stat-failed-count"
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <Card variant="compact">
      <CardContent className="flex flex-col gap-1 px-space-relaxed py-space-relaxed">
        <div className="text-button-sm text-muted">{label}</div>
        <div
          className="text-card-title text-foreground tabular-nums"
          data-testid={testId}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
