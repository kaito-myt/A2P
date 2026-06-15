'use client';

/**
 * AutoApprovalToggle — S-027 設定画面 プロンプト自動承認セクション (T-07-09).
 *
 * Phase 2 用。現在は on/off toggle のみ表示。全体 disabled + 注記。
 */
import { Lock } from 'lucide-react';

import { messages } from '@/lib/messages';

const m = messages.settings;
const ms = m.sections.autoApproval;

export function AutoApprovalToggle() {
  return (
    <section
      aria-labelledby="auto-approval-heading"
      className="rounded-card border border-border-warm bg-cream-light p-space-loose opacity-50"
      data-testid="auto-approval-toggle"
    >
      <div className="mb-space-snug flex items-center gap-2">
        <Lock aria-hidden="true" className="h-4 w-4 text-muted" />
        <div>
          <h2
            id="auto-approval-heading"
            className="text-sub-heading text-foreground"
          >
            {ms.title}
          </h2>
          <p className="text-body text-muted">{ms.subtitle}</p>
        </div>
      </div>

      <div className="flex flex-col gap-space-snug">
        <label
          className="flex cursor-not-allowed items-center gap-2"
          title={m.phase2Note}
        >
          <input
            type="checkbox"
            disabled
            checked={false}
            readOnly
            className="h-4 w-4 cursor-not-allowed opacity-50"
            aria-disabled="true"
          />
          <span className="text-body text-charcoal">{ms.enabledLabel}</span>
        </label>
        <p className="text-button-sm text-muted italic">{m.phase2Note}</p>
      </div>
    </section>
  );
}
