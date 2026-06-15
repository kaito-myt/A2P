'use client';

/**
 * JobStatusBadge — Job ステータスを色・テキストで表示 (S-026, T-09-02).
 *
 * 色のみに依存しない: aria-label で文字情報を補完 (アクセシビリティ).
 * 仕様根拠: docs/04 S-026 / ui-ux-pro-max (color-not-only)
 */
import { messages } from '@/lib/messages';

const m = messages.jobs.status;

type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

function badgeClass(status: string): string {
  switch (status as JobStatus) {
    case 'done':
      return 'bg-green-100 text-green-800';
    case 'running':
      return 'bg-blue-100 text-blue-800';
    case 'failed':
      return 'bg-red-100 text-red-800';
    case 'cancelled':
      return 'bg-gray-100 text-gray-600';
    case 'queued':
    default:
      return 'bg-amber-100 text-amber-800';
  }
}

interface JobStatusBadgeProps {
  status: string;
  className?: string;
}

export function JobStatusBadge({ status, className = '' }: JobStatusBadgeProps) {
  const label = m[status as keyof typeof m] ?? status;
  return (
    <span
      className={`inline-flex items-center rounded px-2 py-0.5 text-caption font-medium ${badgeClass(status)} ${className}`}
      aria-label={`ステータス: ${label}`}
      data-status={status}
    >
      {label}
    </span>
  );
}
