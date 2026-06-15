'use client';

/**
 * ChecklistActionBar — 画面下部固定のアクションバー (T-08-03).
 *
 * 左: "X / N 冊 入稿準備中" + "完了率 8 / 10 項目"
 * 右: [進捗保存] [自動入稿 (Phase 3)](disabled) [次の書籍へ →]
 */
import { messages } from '@/lib/messages';
import type { ChecklistBookView } from '@/lib/kdp-checklist-view';

interface ChecklistActionBarProps {
  overall: {
    checkedCount: number;
    totalCount: number;
    readyCount: number;
  };
  totalBooks: number;
  activeBook: ChecklistBookView;
  lastSavedAt: string | null;
  onNextBook: () => void;
  hasNextBook: boolean;
}

const m = messages.kdpChecklist;

export function ChecklistActionBar({
  overall,
  totalBooks,
  activeBook,
  lastSavedAt,
  onNextBook,
  hasNextBook,
}: ChecklistActionBarProps) {
  return (
    <div
      className="fixed bottom-0 left-60 right-0 z-10 border-t border-border-warm bg-cream px-space-loose py-space-snug shadow-l1-soft"
      data-testid="checklist-action-bar"
      role="region"
      aria-label="アクションバー"
    >
      <div className="flex flex-wrap items-center justify-between gap-space-snug">
        {/* Left: counters + auto-save status */}
        <div className="flex flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-space-snug text-body">
            <span className="text-charcoal">
              {m.submissionCount(overall.readyCount, totalBooks)}
            </span>
            <span className="text-muted">
              {m.completionRate(activeBook.checkedCount, activeBook.totalFieldCount)}
            </span>
          </div>
          {lastSavedAt && (
            <span className="text-caption text-muted">
              {m.autoSaveStatus(formatTimestamp(lastSavedAt))}
            </span>
          )}
        </div>

        {/* Right: action buttons */}
        <div className="flex items-center gap-space-snug">
          {/* 進捗保存 — revalidate は updateChecklist SA が行うので表示のみ */}
          <button
            type="button"
            className="inline-flex items-center rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => {
              /* 進捗は各フィールド操作時に自動保存済み。UI フィードバックのみ。 */
            }}
            data-testid="save-progress-btn"
          >
            {m.saveProgress}
          </button>

          {/* 自動入稿 (Phase 3) */}
          <button
            type="button"
            disabled
            aria-disabled
            title={m.submitKdpTooltip}
            className="inline-flex cursor-not-allowed items-center rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal opacity-50"
            data-testid="auto-submit-btn"
          >
            {m.submitKdpButton}
          </button>

          {/* 次の書籍へ */}
          {hasNextBook && (
            <button
              type="button"
              onClick={onNextBook}
              className="inline-flex items-center rounded-card border border-border-warm bg-charcoal px-3 py-1.5 text-button-sm text-cream hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              data-testid="next-book-btn"
            >
              {m.nextBook}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
