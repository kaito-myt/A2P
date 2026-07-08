'use client';

/**
 * PromotionPlanView — 販促プランの表示。
 *
 * 施策ごとにタブを切り替えて閲覧する（価格 / カテゴリ・キーワード / レビュー /
 * ローンチ / 告知文 / 継続施策）。販促方針 (summary) は常時見える導入バナー。
 * 告知文はワンクリックでコピーできる。
 */
import { useMemo, useState } from 'react';

import { messages } from '@/lib/messages';
import { cn } from '@/lib/cn';
import type { PromotionPlanView as Plan } from '@/lib/promotion-view';

const m = messages.promotion.detail;

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

/** タブ本体を囲むカードシェル。 */
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-space-relaxed rounded-card border border-border-warm bg-cream-light p-space-relaxed">
      {children}
    </div>
  );
}

function PricingPanel({ plan }: { plan: Plan }) {
  const p = plan.pricing;
  const yen = (n?: number) => (typeof n === 'number' ? `¥${n.toLocaleString('ja-JP')}` : '—');
  if (!p) return null;
  return (
    <Panel>
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
    </Panel>
  );
}

function LaunchPanel({ plan }: { plan: Plan }) {
  const list = plan.launch_checklist ?? [];
  if (list.length === 0) return null;
  return (
    <Panel>
      <ul className="flex flex-col gap-1.5">
        {list.map((t, i) => (
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
    </Panel>
  );
}

function PromoCopyPanel({ plan }: { plan: Plan }) {
  const promo = plan.promo_copy;
  if (!promo) return null;
  return (
    <Panel>
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
    </Panel>
  );
}

function OngoingPanel({ plan }: { plan: Plan }) {
  const list = plan.ongoing_calendar ?? [];
  if (list.length === 0) return null;
  return (
    <Panel>
      <ul className="flex flex-col gap-1.5">
        {list.map((o, i) => (
          <li key={i} className="flex items-baseline gap-2 text-body text-charcoal-82">
            <span className="shrink-0 rounded-pill bg-charcoal-04 px-2 py-0.5 text-caption text-charcoal-82">
              {o.when}
            </span>
            <span>{o.action}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

interface Tab {
  key: string;
  label: string;
  render: () => React.ReactNode;
}

export function PromotionPlanView({ plan }: { plan: Plan }) {
  // 中身のある施策だけをタブ化する。
  const tabs = useMemo<Tab[]>(() => {
    const t: Tab[] = [];
    if (plan.pricing) t.push({ key: 'pricing', label: m.pricing, render: () => <PricingPanel plan={plan} /> });
    if (plan.category_keyword_actions && plan.category_keyword_actions.length > 0)
      t.push({
        key: 'category',
        label: m.categoryKeyword,
        render: () => (
          <Panel>
            <Bullets items={plan.category_keyword_actions ?? []} />
          </Panel>
        ),
      });
    if (plan.review_actions && plan.review_actions.length > 0)
      t.push({
        key: 'reviews',
        label: m.reviews,
        render: () => (
          <Panel>
            <Bullets items={plan.review_actions ?? []} />
          </Panel>
        ),
      });
    if (plan.launch_checklist && plan.launch_checklist.length > 0)
      t.push({ key: 'launch', label: m.launchChecklist, render: () => <LaunchPanel plan={plan} /> });
    if (plan.promo_copy) t.push({ key: 'promo', label: m.promoCopy, render: () => <PromoCopyPanel plan={plan} /> });
    if (plan.ongoing_calendar && plan.ongoing_calendar.length > 0)
      t.push({ key: 'ongoing', label: m.ongoing, render: () => <OngoingPanel plan={plan} /> });
    return t;
  }, [plan]);

  const [active, setActive] = useState(0);
  const current = tabs[active] ?? tabs[0];

  return (
    <div className="flex flex-col gap-space-loose" data-testid="promotion-plan-view">
      {plan.summary && (
        <section className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-accent-bg/60 p-space-relaxed">
          <h2 className="text-button-sm font-medium text-accent">{m.summary}</h2>
          <p className="whitespace-pre-wrap text-body text-charcoal">{plan.summary}</p>
        </section>
      )}

      {tabs.length > 0 ? (
        <div className="flex flex-col gap-space-relaxed">
          <div
            role="tablist"
            aria-label={messages.promotion.pageTitle}
            className="scrollbar-none flex gap-1 overflow-x-auto border-b border-border-warm"
          >
            {tabs.map((tab, i) => {
              const selected = i === active;
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setActive(i)}
                  className={cn(
                    '-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-button-sm transition-colors',
                    selected
                      ? 'border-accent font-medium text-accent'
                      : 'border-transparent text-charcoal-82 hover:text-charcoal',
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
          <div role="tabpanel">{current?.render()}</div>
        </div>
      ) : (
        <div className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center">
          <p className="text-body text-muted">{m.notGenerated}</p>
        </div>
      )}
    </div>
  );
}
