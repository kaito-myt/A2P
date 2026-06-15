/**
 * S-007 テーマ概要セクション (T-03-08).
 *
 * hook (差別化要素) と target_reader (想定読者) を表示。
 * rejected ステータスなら rejected_reason も同セクションに含める。
 *
 * マークダウンは Phase 1 では未パース (Marketer 出力は基本的にプレーン日本語)。
 * 改行を保つ程度に `whitespace-pre-wrap` を当てる。
 */
import { messages } from '@/lib/messages';
import type { ThemeDetailSerialized } from '@/lib/themes-view';

const ms = messages.themes.detail.summary;

interface ThemeSummarySectionProps {
  detail: ThemeDetailSerialized;
}

export function ThemeSummarySection({ detail }: ThemeSummarySectionProps) {
  return (
    <section
      data-testid="theme-summary-section"
      className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed"
    >
      <h2 className="text-button font-medium text-charcoal">{ms.sectionTitle}</h2>

      <div className="flex flex-col gap-1">
        <p className="text-button-sm text-charcoal-82">{ms.hookLabel}</p>
        <p
          data-testid="theme-hook"
          className="text-body text-charcoal whitespace-pre-wrap"
        >
          {detail.hook && detail.hook.trim().length > 0
            ? detail.hook
            : ms.hookEmpty}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-button-sm text-charcoal-82">{ms.targetReaderLabel}</p>
        <p
          data-testid="theme-target-reader"
          className="text-body text-charcoal whitespace-pre-wrap"
        >
          {detail.target_reader && detail.target_reader.trim().length > 0
            ? detail.target_reader
            : ms.targetReaderEmpty}
        </p>
      </div>

      {detail.status === 'rejected' && detail.rejected_reason && (
        <div className="flex flex-col gap-1">
          <p className="text-button-sm text-destructive">{ms.rejectedReasonLabel}</p>
          <p
            data-testid="theme-rejected-reason"
            className="text-body text-charcoal whitespace-pre-wrap"
          >
            {detail.rejected_reason}
          </p>
        </div>
      )}
    </section>
  );
}
