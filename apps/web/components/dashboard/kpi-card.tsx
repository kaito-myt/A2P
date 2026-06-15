/**
 * KPI カード骨格 (S-002 Section 1) — docs/04 §6.3.5 L1 Bordered。
 */
import { Card, CardContent } from '@/components/ui/card';

interface KpiCardProps {
  label: string;
  /** 現在値 (未集計時は "—") */
  value?: string;
  /** "/ 100 冊" のようなサフィックス */
  suffix?: string;
  /** 前月比テキスト e.g. "前月比 +2.1" — 正ならグリーン、負ならレッド、0 またはなしはミュート */
  change?: string;
  /** change テキストの正負方向: 'positive' | 'negative' | 'neutral' */
  changeDir?: 'positive' | 'negative' | 'neutral';
}

export function KpiCard({ label, value = '—', suffix, change, changeDir = 'neutral' }: KpiCardProps) {
  const changeColor =
    changeDir === 'positive'
      ? 'text-green-700'
      : changeDir === 'negative'
        ? 'text-red-600'
        : 'text-muted';

  return (
    <Card variant="compact">
      <CardContent className="flex flex-col gap-1 px-space-relaxed py-space-relaxed">
        <div className="text-button-sm text-muted">{label}</div>
        <div className="flex items-baseline gap-2">
          <span className="text-card-title text-foreground">{value}</span>
          {suffix && <span className="text-button-sm text-muted">{suffix}</span>}
        </div>
        {change && (
          <div className={`text-caption ${changeColor}`}>{change}</div>
        )}
      </CardContent>
    </Card>
  );
}
