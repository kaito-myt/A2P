'use client';

/**
 * TokenUsageInline — このジョブのトークン使用量カード (S-026, T-09-02, F-032〜F-035).
 *
 * 入力 / 出力 / キャッシュトークン + cost_jpy を表示。
 * 仕様根拠: docs/wireframes/S-026-job-detail/prompt.md §Section 6
 */
import type { TokenUsageSerialized } from '@/lib/jobs-view';
import { messages } from '@/lib/messages';

const m = messages.jobs.detail;

interface TokenUsageInlineProps {
  tokenUsages: TokenUsageSerialized[];
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostJpy: string;
}

export function TokenUsageInline({
  tokenUsages,
  totalInputTokens,
  totalOutputTokens,
  totalCostJpy,
}: TokenUsageInlineProps) {
  const isEmpty = tokenUsages.length === 0;

  return (
    <section
      aria-label={m.tokenSection}
      className="rounded-card border border-border-warm bg-white p-space-normal"
    >
      <h2 className="text-body font-medium text-foreground">{m.tokenSection}</h2>

      {isEmpty ? (
        <p className="mt-space-snug text-caption text-muted">{m.tokenEmpty}</p>
      ) : (
        <dl className="mt-space-snug flex flex-col gap-space-snug">
          <div className="flex items-center justify-between">
            <dt className="text-caption text-muted">{m.inputTokens}</dt>
            <dd className="tabular-nums text-body text-foreground">
              {totalInputTokens.toLocaleString('ja-JP')}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-caption text-muted">{m.outputTokens}</dt>
            <dd className="tabular-nums text-body text-foreground">
              {totalOutputTokens.toLocaleString('ja-JP')}
            </dd>
          </div>
          {tokenUsages.some((t) => t.cached_input_tokens > 0) && (
            <div className="flex items-center justify-between">
              <dt className="text-caption text-muted">{m.cachedTokens}</dt>
              <dd className="tabular-nums text-body text-foreground">
                {tokenUsages
                  .reduce((s, t) => s + t.cached_input_tokens, 0)
                  .toLocaleString('ja-JP')}
              </dd>
            </div>
          )}
          <div className="mt-1 flex items-center justify-between border-t border-border-warm pt-space-snug">
            <dt className="text-caption font-medium text-muted">{m.costJpy}</dt>
            <dd className="tabular-nums text-body font-medium text-foreground">
              ¥{parseFloat(totalCostJpy).toLocaleString('ja-JP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
