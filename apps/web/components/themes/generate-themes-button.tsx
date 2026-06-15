'use client';

/**
 * GenerateThemesModal の入口ボタン (T-03-07 placeholder).
 *
 * S-006 のヘッダ右上に置く CTA。本格的なモーダル UI は T-03-09 で実装予定のため、
 * 本タスクでは alert() で「次タスクで実装」を案内するだけのスタブにする。
 * (アクセシビリティ: alert はテストでは window.alert を spy できる)。
 */
import { Button } from '@/components/ui/button';
import { messages } from '@/lib/messages';

const m = messages.themes;

export function GenerateThemesButton() {
  function onClick() {
    if (typeof window !== 'undefined') {
      window.alert(m.generateNotImplemented);
    }
  }
  return (
    <Button
      type="button"
      variant="default"
      onClick={onClick}
      data-testid="themes-generate-button"
    >
      {m.generateButton}
    </Button>
  );
}
