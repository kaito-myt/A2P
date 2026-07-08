'use client';

/**
 * PromotionAutomationSettings (F-052) — S-027 設定画面 販促自動運用セクション。
 *
 * 2 つのグローバルトグル:
 *   - promo_auto_on_publish_enabled: 出版済み化で販促プランを自動立案
 *   - promo_auto_post_enabled:        自動投稿ディスパッチャを有効化
 */
import { useCallback, useState } from 'react';
import { CheckCircle, XCircle, Info } from 'lucide-react';

import { updateSettings } from '@/app/actions/settings';
import { messages } from '@/lib/messages';

const m = messages.settings;
const ms = m.sections.promotionAutomation;

interface Props {
  initialOnPublish: boolean;
  initialAutoPost: boolean;
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground ${
          checked ? 'bg-foreground' : 'bg-border-warm'
        }`}
      >
        <span
          aria-hidden="true"
          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ease-in-out ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
      <span className="text-body text-charcoal">{label}</span>
    </label>
  );
}

export function PromotionAutomationSettings({ initialOnPublish, initialAutoPost }: Props) {
  const [onPublish, setOnPublish] = useState(initialOnPublish);
  const [autoPost, setAutoPost] = useState(initialAutoPost);
  const [isPending, setIsPending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setIsPending(true);
      setFeedback(null);
      const res = await updateSettings({
        promo_auto_on_publish_enabled: onPublish,
        promo_auto_post_enabled: autoPost,
      });
      setIsPending(false);
      setFeedback(res.ok ? { ok: true, msg: m.saveSuccess } : { ok: false, msg: res.error.message });
    },
    [onPublish, autoPost],
  );

  return (
    <section
      aria-labelledby="promo-automation-heading"
      className="rounded-card border border-border-warm bg-cream-light p-space-loose"
      data-testid="promotion-automation-settings"
    >
      <div className="mb-space-snug">
        <h2 id="promo-automation-heading" className="text-sub-heading text-foreground">
          {ms.title}
        </h2>
        <p className="text-body text-muted">{ms.subtitle}</p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-space-loose">
        <div className="flex flex-col gap-2">
          <Switch checked={onPublish} onChange={setOnPublish} label={ms.onPublishLabel} />
          <p className="pl-14 text-button-sm text-muted">{ms.onPublishHint}</p>
        </div>

        <div className="flex flex-col gap-2">
          <Switch checked={autoPost} onChange={setAutoPost} label={ms.autoPostLabel} />
          <p className="pl-14 text-button-sm text-muted">{ms.autoPostHint}</p>
        </div>

        <div className="flex items-start gap-2 rounded-button border border-border-warm bg-white px-3 py-2">
          <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <p className="text-button-sm text-muted">{ms.workerRestartNote}</p>
        </div>

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
              {feedback.ok ? (
                <CheckCircle aria-hidden="true" className="h-4 w-4" />
              ) : (
                <XCircle aria-hidden="true" className="h-4 w-4" />
              )}
              {feedback.msg}
            </div>
          )}
        </div>
      </form>
    </section>
  );
}
