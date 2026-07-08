'use client';

/**
 * PromotionPlanView — 販促プランの表示。告知文はワンクリックでコピーできる。
 */
import { useState } from 'react';

import { messages } from '@/lib/messages';
import type { PromotionPlanView as Plan } from '@/lib/promotion-view';

const m = messages.promotion.detail;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed">
      <h2 className="text-card-title font-medium text-charcoal">{title}</h2>
      {children}
    </section>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* insecure context */
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className={`shrink-0 rounded-card border px-2.5 py-1 text-caption transition-colors ${
        copied ? 'border-success bg-success-bg text-success' : 'border-border-warm bg-cream text-charcoal hover:bg-charcoal-04'
      }`}
    >
      {copied ? m.copied : m.copy}
    </button>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-body text-charcoal-82">
      {items.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ul>
  );
}

export function PromotionPlanView({ plan }: { plan: Plan }) {
  const p = plan.pricing;
  const promo = plan.promo_copy;
  const yen = (n?: number) => (typeof n === 'number' ? `¥${n.toLocaleString('ja-JP')}` : '—');

  return (
    <div className="flex flex-col gap-space-loose" data-testid="promotion-plan-view">
      {plan.summary && (
        <Section title={m.summary}>
          <p className="whitespace-pre-wrap text-body text-charcoal">{plan.summary}</p>
        </Section>
      )}

      {p && (
        <Section title={m.pricing}>
          <div className="flex flex-wrap gap-space-loose">
            <div>
              <div className="text-caption text-muted">{m.launchPrice}</div>
              <div className="text-card-title font-medium text-charcoal">{yen(p.launch_price_jpy)}</div>
            </div>
            <div>
              <div className="text-caption text-muted">{m.regularPrice}</div>
              <div className="text-card-title font-medium text-charcoal">{yen(p.regular_price_jpy)}</div>
            </div>
            <div>
              <div className="text-caption text-muted">{m.kdpSelect}</div>
              <div
                className={`text-card-title font-medium ${
                  p.kdp_select_recommended ? 'text-success' : 'text-charcoal-82'
                }`}
              >
                {p.kdp_select_recommended ? m.kdpSelectYes : m.kdpSelectNo}
              </div>
            </div>
          </div>
          {p.tactics && p.tactics.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-button-sm text-charcoal-82">{m.tactics}</div>
              <Bullets items={p.tactics} />
            </div>
          )}
        </Section>
      )}

      {plan.category_keyword_actions && plan.category_keyword_actions.length > 0 && (
        <Section title={m.categoryKeyword}>
          <Bullets items={plan.category_keyword_actions} />
        </Section>
      )}

      {plan.review_actions && plan.review_actions.length > 0 && (
        <Section title={m.reviews}>
          <Bullets items={plan.review_actions} />
        </Section>
      )}

      {plan.launch_checklist && plan.launch_checklist.length > 0 && (
        <Section title={m.launchChecklist}>
          <ul className="flex flex-col gap-1.5">
            {plan.launch_checklist.map((t, i) => (
              <li key={i} className="flex items-baseline gap-2 text-body text-charcoal-82">
                <span aria-hidden className="text-accent">☐</span>
                {t.timing && (
                  <span className="shrink-0 rounded-pill bg-accent-bg px-2 py-0.5 text-caption text-accent">
                    {t.timing}
                  </span>
                )}
                <span>{t.task}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {promo && (
        <Section title={m.promoCopy}>
          {promo.x_posts && promo.x_posts.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="text-button-sm text-charcoal-82">{m.xPosts}</div>
              {promo.x_posts.map((post, i) => (
                <div
                  key={i}
                  className="flex items-start justify-between gap-2 rounded-card border border-border-warm bg-cream p-space-snug"
                >
                  <p className="whitespace-pre-wrap text-button-sm text-charcoal">{post}</p>
                  <CopyButton text={post} />
                </div>
              ))}
            </div>
          )}
          {promo.note_article && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <div className="text-button-sm text-charcoal-82">{m.noteArticle}</div>
                <CopyButton text={promo.note_article} />
              </div>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-card border border-border-warm bg-cream p-space-snug text-button-sm text-charcoal">
                {promo.note_article}
              </pre>
            </div>
          )}
          {promo.blog_outline && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <div className="text-button-sm text-charcoal-82">{m.blogOutline}</div>
                <CopyButton text={promo.blog_outline} />
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-card border border-border-warm bg-cream p-space-snug text-button-sm text-charcoal">
                {promo.blog_outline}
              </pre>
            </div>
          )}
        </Section>
      )}

      {plan.ongoing_calendar && plan.ongoing_calendar.length > 0 && (
        <Section title={m.ongoing}>
          <ul className="flex flex-col gap-1.5">
            {plan.ongoing_calendar.map((o, i) => (
              <li key={i} className="flex items-baseline gap-2 text-body text-charcoal-82">
                <span className="shrink-0 rounded-pill bg-charcoal-04 px-2 py-0.5 text-caption text-charcoal-82">
                  {o.when}
                </span>
                <span>{o.action}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
