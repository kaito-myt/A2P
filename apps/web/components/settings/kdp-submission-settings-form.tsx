'use client';

/**
 * KdpSubmissionSettingsForm — S-027 設定画面 KDP 自動入稿設定セクション (T-07-09).
 *
 * Phase 3 用。全体 disabled + 注記。
 */
import { Lock } from 'lucide-react';

import { messages } from '@/lib/messages';

const m = messages.settings;
const ms = m.sections.kdpSubmission;

interface KdpSubmissionSettingsFormProps {
  initialData: {
    kdp_submit_timeout_minutes: number;
    kdp_submit_retry_count: number;
  };
}

export function KdpSubmissionSettingsForm({ initialData }: KdpSubmissionSettingsFormProps) {
  return (
    <section
      aria-labelledby="kdp-submission-heading"
      className="rounded-card border border-border-warm bg-cream-light p-space-loose opacity-50"
      data-testid="kdp-submission-settings-form"
    >
      <div className="mb-space-snug flex items-center gap-2">
        <Lock aria-hidden="true" className="h-4 w-4 text-muted" />
        <div>
          <h2
            id="kdp-submission-heading"
            className="text-sub-heading text-foreground"
          >
            {ms.title}
          </h2>
          <p className="text-body text-muted">{ms.subtitle}</p>
        </div>
      </div>

      <div className="flex flex-col gap-space-snug">
        <div className="flex flex-col gap-1">
          <label htmlFor="kdp-timeout" className="text-body font-medium text-charcoal">
            {ms.timeoutLabel}
          </label>
          <input
            id="kdp-timeout"
            type="number"
            disabled
            value={initialData.kdp_submit_timeout_minutes}
            readOnly
            aria-disabled="true"
            className="w-40 cursor-not-allowed rounded-button border border-border-warm bg-white px-3 py-2 text-body text-charcoal opacity-50"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="kdp-retry" className="text-body font-medium text-charcoal">
            {ms.retryCountLabel}
          </label>
          <input
            id="kdp-retry"
            type="number"
            disabled
            value={initialData.kdp_submit_retry_count}
            readOnly
            aria-disabled="true"
            className="w-40 cursor-not-allowed rounded-button border border-border-warm bg-white px-3 py-2 text-body text-charcoal opacity-50"
          />
        </div>
        <p className="text-button-sm text-muted italic">{m.phase3Note}</p>
      </div>
    </section>
  );
}
