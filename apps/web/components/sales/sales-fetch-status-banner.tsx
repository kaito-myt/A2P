'use client';

/**
 * SalesFetchStatusBanner — S-017 自動取得ステータスバナー + 手動更新ボタン (T-12-07, F-038).
 *
 * Props:
 *  - latestRun: SalesFetchRunSerialized | null
 *  - accountId: string
 *
 * 状態別表示:
 *  - null: 「まだ自動取得を実行していません」+「今すぐ取得」ボタン
 *  - running: 「取得中...」Skeleton + ボタン無効
 *  - done: 「✓ 最終取得: {finished_at 相対時刻}（{records_upserted} 件更新）」+「再取得」ボタン
 *  - failed: 赤バナー「エラー: {error_message}」+「再試行」ボタン
 *  - 2fa_waiting: 橙バナー「2FA 認証待ち — メールで承認してください」（ボタン無し）
 *
 * 仕様根拠: SP-12 T-12-07 / docs/04 S-017
 */
import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { triggerSalesFetch } from '@/app/actions/sales';
import { messages } from '@/lib/messages';
import { formatRelativeTime, type SalesFetchRunSerialized } from '@/lib/sales-fetch-view';
import { cn } from '@/lib/cn';

function getCurrentYearMonth(): string {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${mo}`;
}

const m = messages.salesFetch;

interface SalesFetchStatusBannerProps {
  latestRun: SalesFetchRunSerialized | null;
  accountId: string;
}

export function SalesFetchStatusBanner({
  latestRun,
  accountId,
}: SalesFetchStatusBannerProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // running 状態では 5s ポーリング
  useEffect(() => {
    if (latestRun?.status !== 'running') return;
    const id = setInterval(() => {
      router.refresh();
    }, 5000);
    return () => clearInterval(id);
  }, [latestRun?.status, router]);

  const handleTrigger = useCallback(() => {
    setErrorMsg(null);
    startTransition(async () => {
      const result = await triggerSalesFetch({
        account_id: accountId,
        year_month: getCurrentYearMonth(),
      });
      if (!result.ok) {
        setErrorMsg(result.error.message ?? m.errors.unknown);
        return;
      }
      router.refresh();
    });
  }, [accountId, router]);

  const isRunning = latestRun?.status === 'running' || pending;

  return (
    <div
      data-testid="sales-fetch-banner"
      className="flex flex-col gap-space-snug"
    >
      {/* エラー通知（SA 呼出失敗時） */}
      {errorMsg && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-card border border-destructive/40 bg-destructive/10 px-3 py-2 text-body-sm text-destructive"
          data-testid="sales-fetch-error"
        >
          {errorMsg}
        </div>
      )}

      {/* ステータス別バナー */}
      <BannerContent
        latestRun={latestRun}
        isRunning={isRunning}
        onTrigger={handleTrigger}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 内部: ステータス別バナー本体
// ---------------------------------------------------------------------------

interface BannerContentProps {
  latestRun: SalesFetchRunSerialized | null;
  isRunning: boolean;
  onTrigger: () => void;
}

function BannerContent({ latestRun, isRunning, onTrigger }: BannerContentProps) {
  // null — まだ実行なし
  if (latestRun === null) {
    return (
      <div
        className="flex flex-wrap items-center gap-space-snug rounded-card border border-border-warm bg-surface px-3 py-2 text-body-sm text-muted"
        data-testid="sales-fetch-banner-null"
      >
        <span>{m.banner.nullStatus}</span>
        <TriggerButton
          onClick={onTrigger}
          disabled={isRunning}
          label={m.banner.triggerButton}
          testId="sales-fetch-trigger"
        />
      </div>
    );
  }

  // running
  if (latestRun.status === 'running') {
    return (
      <div
        className="flex flex-wrap items-center gap-space-snug rounded-card border border-border-warm bg-surface px-3 py-2 text-body-sm text-charcoal"
        data-testid="sales-fetch-banner-running"
      >
        {/* Skeleton */}
        <div className="flex items-center gap-2">
          <div
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-charcoal border-t-transparent"
          />
          <span>{m.banner.running}</span>
        </div>
        <TriggerButton
          onClick={onTrigger}
          disabled={true}
          label={m.banner.retriggerButton}
          testId="sales-fetch-trigger"
        />
      </div>
    );
  }

  // done
  if (latestRun.status === 'done') {
    const relativeTime = latestRun.finished_at
      ? formatRelativeTime(latestRun.finished_at)
      : '—';
    return (
      <div
        className="flex flex-wrap items-center gap-space-snug rounded-card border border-green-300 bg-green-50 px-3 py-2 text-body-sm text-green-800"
        data-testid="sales-fetch-banner-done"
      >
        <span data-testid="sales-fetch-banner-done-message">
          {m.banner.done(relativeTime, latestRun.records_upserted)}
        </span>
        <TriggerButton
          onClick={onTrigger}
          disabled={false}
          label={m.banner.retriggerButton}
          testId="sales-fetch-trigger"
          variant="green"
        />
      </div>
    );
  }

  // failed
  if (latestRun.status === 'failed') {
    return (
      <div
        className="flex flex-wrap items-center gap-space-snug rounded-card border border-destructive/40 bg-destructive/10 px-3 py-2 text-body-sm text-destructive"
        data-testid="sales-fetch-banner-failed"
        role="alert"
      >
        <span data-testid="sales-fetch-banner-failed-message">
          {m.banner.failed(latestRun.error_message ?? '')}
        </span>
        <TriggerButton
          onClick={onTrigger}
          disabled={false}
          label={m.banner.retryButton}
          testId="sales-fetch-trigger"
          variant="destructive"
        />
      </div>
    );
  }

  // 2fa_waiting
  if (latestRun.status === '2fa_waiting') {
    return (
      <div
        className="flex items-center gap-space-snug rounded-card border border-orange-300 bg-orange-50 px-3 py-2 text-body-sm text-orange-800"
        data-testid="sales-fetch-banner-2fa"
        role="status"
      >
        {m.banner.twoFaWaiting}
      </div>
    );
  }

  // 未知ステータス — フォールバック
  return null;
}

// ---------------------------------------------------------------------------
// 内部: トリガーボタン
// ---------------------------------------------------------------------------

interface TriggerButtonProps {
  onClick: () => void;
  disabled: boolean;
  label: string;
  testId: string;
  variant?: 'default' | 'green' | 'destructive';
}

function TriggerButton({
  onClick,
  disabled,
  label,
  testId,
  variant = 'default',
}: TriggerButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center rounded-card px-3 py-1.5 text-button-sm transition-opacity',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
        variant === 'default' &&
          'bg-charcoal text-white hover:bg-charcoal/90',
        variant === 'green' &&
          'border border-green-400 bg-green-100 text-green-800 hover:bg-green-200',
        variant === 'destructive' &&
          'border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20',
      )}
    >
      {label}
    </button>
  );
}
