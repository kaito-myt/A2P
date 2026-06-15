'use client';

/**
 * PlanGenerationParams — 折りたたみ式プラン生成パラメータセクション (T-08-02, S-005).
 *
 * Progressive disclosure: 初期状態は折りたたみ (closed)。
 * aria-expanded / aria-controls でアクセシブルなトグル。
 */
import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { messages } from '@/lib/messages';

const m = messages.plans.paramsSection;

interface PlanGenerationParamsProps {
  /** 外部からパラメータ変更を受け取るコールバック (将来の拡張用) */
  onChange?: (params: PlanParams) => void;
}

export interface PlanParams {
  target_count_per_month: number;
  focus_categories: string;
  series_policy: string;
}

export function PlanGenerationParams({ onChange }: PlanGenerationParamsProps) {
  const [open, setOpen] = useState(false);
  const [params, setParams] = useState<PlanParams>({
    target_count_per_month: 3,
    focus_categories: '',
    series_policy: '',
  });

  function updateParam<K extends keyof PlanParams>(key: K, value: PlanParams[K]) {
    const next = { ...params, [key]: value };
    setParams(next);
    onChange?.(next);
  }

  const sectionId = 'plan-generation-params-content';

  return (
    <section aria-label={m.heading}>
      {/* トグルボタン */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={sectionId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-card border border-border-warm bg-cream-light px-4 py-3 text-left text-sub-heading text-foreground cursor-pointer focus-visible:ring-2 focus-visible:ring-offset-2"
      >
        <span>{m.heading}</span>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted" aria-hidden="true" />
        )}
      </button>

      {/* コンテンツ (折りたたみ) */}
      <div
        id={sectionId}
        hidden={!open}
        className="mt-1 flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light px-4 py-4"
      >
        {/* 月あたり上限冊数 */}
        <div className="flex flex-col gap-1">
          <label htmlFor="target-count-per-month" className="text-button-sm text-charcoal font-medium">
            {m.targetCountLabel}
          </label>
          <div className="flex items-center gap-2">
            <input
              id="target-count-per-month"
              type="number"
              min={1}
              max={30}
              value={params.target_count_per_month}
              onChange={(e) => updateParam('target_count_per_month', Math.max(1, Number(e.target.value)))}
              className="w-24 rounded border border-border-warm bg-white px-2 py-1 text-body text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
            />
            <span className="text-button-sm text-muted">{m.targetCountUnit}</span>
          </div>
        </div>

        {/* 注力カテゴリ */}
        <div className="flex flex-col gap-1">
          <label htmlFor="focus-categories" className="text-button-sm text-charcoal font-medium">
            {m.focusCategoriesLabel}
          </label>
          <input
            id="focus-categories"
            type="text"
            value={params.focus_categories}
            onChange={(e) => updateParam('focus_categories', e.target.value)}
            placeholder={m.focusCategoriesPlaceholder}
            className="rounded border border-border-warm bg-white px-3 py-1.5 text-body text-foreground placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
          />
        </div>

        {/* シリーズ展開ポリシー */}
        <div className="flex flex-col gap-1">
          <label htmlFor="series-policy" className="text-button-sm text-charcoal font-medium">
            {m.seriesPolicyLabel}
          </label>
          <textarea
            id="series-policy"
            value={params.series_policy}
            onChange={(e) => updateParam('series_policy', e.target.value)}
            placeholder={m.seriesPolicyPlaceholder}
            rows={3}
            className="rounded border border-border-warm bg-white px-3 py-2 text-body text-foreground placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 resize-none"
          />
        </div>
      </div>
    </section>
  );
}
