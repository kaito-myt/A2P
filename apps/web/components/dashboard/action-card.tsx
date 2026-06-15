/**
 * ActionRequiredCard 骨格 (S-002 Section 2)。
 * Phase 1 SP-01 では件数 0 と「画面へ」CTA を disabled で表示。
 */
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { messages } from '@/lib/messages';

interface ActionCardProps {
  label: string;
  /** 0 表示が既定 */
  count?: number;
  /** must 件数 (修正コメントカード用) */
  must?: number;
}

export function ActionCard({ label, count = 0, must }: ActionCardProps) {
  return (
    <Card variant="compact">
      <CardContent className="flex flex-col gap-space-snug px-space-relaxed py-space-relaxed">
        <div className="flex items-baseline justify-between">
          <span className="text-button-sm text-muted">{label}</span>
          <span className="text-card-title text-foreground">{count}</span>
        </div>
        {typeof must === 'number' && (
          <span className="text-button-sm text-destructive">must: {must}</span>
        )}
        <Button variant="outline" size="sm" disabled>
          {messages.dashboard.actions.cta}
        </Button>
      </CardContent>
    </Card>
  );
}
