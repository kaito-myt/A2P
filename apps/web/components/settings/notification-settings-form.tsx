'use client';

/**
 * NotificationSettingsForm — S-027 設定画面 通知設定セクション (T-07-09).
 *
 * Manages notification_email_to + per-kind ON/OFF toggles.
 * Uses manual isPending state (NOT useTransition) per UI/UX requirement.
 */
import { useState, useCallback } from 'react';
import { Mail, CheckCircle, XCircle } from 'lucide-react';

import { updateSettings } from '@/app/actions/settings';
import { messages } from '@/lib/messages';

const m = messages.settings;
const ms = m.sections.notification;

const ALERT_KIND_KEYS: Array<keyof typeof ms.kindLabels> = [
  'cost_per_book_warn',
  'cost_per_book_pause',
  'monthly_cost_80',
  'monthly_cost_95',
  'monthly_cost_100',
  'book_done',
  'revision_run_done',
  'job_failed',
];

interface NotificationSettingsFormProps {
  initialEmail: string;
  initialKinds: Record<string, boolean>;
}

export function NotificationSettingsForm({
  initialEmail,
  initialKinds,
}: NotificationSettingsFormProps) {
  const [email, setEmail] = useState(initialEmail);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [kinds, setKinds] = useState<Record<string, boolean>>(() => {
    const base: Record<string, boolean> = {};
    for (const k of ALERT_KIND_KEYS) {
      base[k] = initialKinds[k] ?? true;
    }
    return base;
  });
  const [isPending, setIsPending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const validateEmail = useCallback((val: string): string | null => {
    if (!val) return '通知メール宛先を入力してください';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) return '有効なメールアドレスを入力してください';
    return null;
  }, []);

  const handleEmailBlur = useCallback(() => {
    setEmailError(validateEmail(email));
  }, [email, validateEmail]);

  const handleToggle = useCallback((kind: string) => {
    setKinds((prev) => ({ ...prev, [kind]: !prev[kind] }));
  }, []);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validateEmail(email);
    if (err) {
      setEmailError(err);
      return;
    }
    setIsPending(true);
    setFeedback(null);
    const result = await updateSettings({
      notification_email_to: email,
      notification_kinds: kinds,
    });
    setIsPending(false);
    if (result.ok) {
      setFeedback({ ok: true, msg: m.saveSuccess });
    } else {
      setFeedback({ ok: false, msg: result.error.message });
    }
  }, [email, kinds, validateEmail]);

  return (
    <section
      aria-labelledby="notification-settings-heading"
      className="rounded-card border border-border-warm bg-cream-light p-space-loose"
      data-testid="notification-settings-form"
    >
      <div className="mb-space-snug">
        <h2
          id="notification-settings-heading"
          className="text-sub-heading text-foreground"
        >
          {ms.title}
        </h2>
        <p className="text-body text-muted">{ms.subtitle}</p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-space-snug">
        {/* Email */}
        <div className="flex flex-col gap-1">
          <label htmlFor="notification-email" className="text-body font-medium text-charcoal">
            {ms.emailToLabel}
          </label>
          <div className="flex items-center gap-2">
            <Mail aria-hidden="true" className="h-4 w-4 text-muted" />
            <input
              id="notification-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={handleEmailBlur}
              placeholder={ms.emailToPlaceholder}
              className="flex-1 rounded-button border border-border-warm bg-white px-3 py-2 text-body text-charcoal placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
            />
          </div>
          {emailError && (
            <p role="alert" className="text-button-sm text-destructive">
              {emailError}
            </p>
          )}
        </div>

        {/* Kind toggles */}
        <div className="flex flex-col gap-2">
          <p className="text-body font-medium text-charcoal">{ms.kindToggleHeading}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {ALERT_KIND_KEYS.map((kind) => (
              <label
                key={kind}
                className="flex cursor-pointer items-center gap-2 rounded-button border border-border-warm bg-white px-3 py-2"
              >
                <input
                  type="checkbox"
                  checked={kinds[kind] ?? true}
                  onChange={() => handleToggle(kind)}
                  className="h-4 w-4 cursor-pointer accent-foreground focus-visible:ring-2 focus-visible:ring-foreground"
                />
                <span className="text-body text-charcoal">
                  {ms.kindLabels[kind] ?? kind}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Submit */}
        <div className="flex items-center gap-space-snug pt-2">
          <button
            type="submit"
            disabled={isPending}
            className="rounded-button bg-foreground px-4 py-2 text-button-sm font-medium text-white disabled:opacity-50"
          >
            {isPending ? m.saving : m.saveButton}
          </button>
          {feedback && (
            <div
              role="status"
              aria-live="polite"
              className={`flex items-center gap-1 text-button-sm ${feedback.ok ? 'text-green-700' : 'text-destructive'}`}
            >
              {feedback.ok
                ? <CheckCircle aria-hidden="true" className="h-4 w-4" />
                : <XCircle aria-hidden="true" className="h-4 w-4" />}
              {feedback.msg}
            </div>
          )}
        </div>
      </form>
    </section>
  );
}
