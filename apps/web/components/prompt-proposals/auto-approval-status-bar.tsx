'use client';

/**
 * AutoApprovalStatusBar — S-023 上部ステータスバー (T-11-07).
 *
 * - 自動承認モード（手動/自動）トグル表示 → S-027 設定へリンク
 * - 直近 5 冊スコア改善中 N/5 進捗
 * - ロールバック猶予メモ
 *
 * Phase 2: eval_results からのスコア改善カウントは未実装のため 0 固定。
 */
import Link from 'next/link';

import { messages } from '@/lib/messages';
import type { AutoApprovalStatus } from '@/lib/prompt-proposals-view';

const m = messages.promptProposals.statusBar;

const SCORE_IMPROVEMENT_COUNT = 0; // Phase 2 で eval_results から計算

interface AutoApprovalStatusBarProps {
  status: AutoApprovalStatus;
}

export function AutoApprovalStatusBar({ status }: AutoApprovalStatusBarProps) {
  return (
    <div
      data-testid="auto-approval-status-bar"
      className="flex flex-wrap items-center gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-snug"
    >
      {/* 自動承認モード */}
      <div className="flex items-center gap-2">
        <span className="text-button-sm text-muted">{m.modeLabel}:</span>
        <span className="rounded-default border border-charcoal-40 px-2 py-0.5 text-button-sm font-medium text-charcoal">
          {status.enabled ? m.modeAuto : m.modeManual}
        </span>
        <Link
          href="/settings"
          className="text-button-sm text-accent underline-offset-2 hover:underline"
          data-testid="status-bar-settings-link"
        >
          {m.settingsLink}
        </Link>
      </div>

      <span aria-hidden="true" className="text-charcoal-40">|</span>

      {/* スコア改善進捗 */}
      <div className="flex items-center gap-2" data-testid="score-improvement-bar">
        <span className="text-button-sm text-muted">{m.scoreLabel}:</span>
        <span className="text-button-sm font-medium text-charcoal">
          {m.scoreProgress(SCORE_IMPROVEMENT_COUNT)}
        </span>
        <div
          className="h-2 w-24 overflow-hidden rounded-full bg-charcoal-04"
          aria-label={m.scoreProgress(SCORE_IMPROVEMENT_COUNT)}
        >
          <div
            className="h-full rounded-full bg-success"
            style={{ width: `${(SCORE_IMPROVEMENT_COUNT / 5) * 100}%` }}
          />
        </div>
      </div>

      <span aria-hidden="true" className="text-charcoal-40">|</span>

      {/* ロールバック猶予メモ */}
      <span className="text-button-sm text-muted">{m.rollbackNote}</span>
    </div>
  );
}
