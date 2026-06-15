/**
 * Section — S-002 ダッシュボード共通セクションラッパ (docs/04 §6.3.5 L1 Bordered)。
 * Card と同じ枠線/角丸を持ち、内部に SectionHeading + 子要素を配置する。
 */
import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface SectionProps {
  title: string;
  /** 右上に置く件数や ActionButton 用スロット */
  action?: ReactNode;
  children: ReactNode;
}

export function Section({ title, action, children }: SectionProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-space-snug">
        <CardTitle>{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
