'use client';

/**
 * SubmitToKdpButton — Phase 3 まで常に disabled (T-08-03, F-041).
 *
 * aria-disabled + tooltip で理由を伝える (アクセシビリティ要件)。
 */
import { messages } from '@/lib/messages';

interface SubmitToKdpButtonProps {
  disabled: boolean;
}

const m = messages.kdpChecklist;

export function SubmitToKdpButton({ disabled }: SubmitToKdpButtonProps) {
  return (
    <div className="relative inline-block" data-testid="submit-to-kdp-wrapper">
      <button
        type="button"
        disabled={disabled}
        aria-disabled={disabled}
        title={disabled ? m.submitKdpTooltip : undefined}
        className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-card border border-border-warm bg-cream px-4 py-2 text-button-sm text-charcoal opacity-50"
        data-testid="submit-to-kdp-btn"
      >
        {m.submitKdpButton}
        <span className="rounded-pill bg-charcoal-04 px-1.5 py-0.5 text-caption text-muted">
          Phase 3
        </span>
      </button>
    </div>
  );
}
