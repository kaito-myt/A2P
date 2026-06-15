'use client';

/**
 * CopyToClipboardButton — コピーして自動チェックも更新する (T-08-03, F-020).
 *
 * - コピー成功後 1.5s だけ「コピー済み」フィードバックを表示
 * - コピー時に updateChecklist SA を呼んで copied=true / checked=true を永続化
 * - 楽観的更新: onCopied コールバックで親の state を即時更新
 */
import { useState, useTransition } from 'react';

import { updateChecklist } from '@/app/actions/kdp-checklist';
import { messages } from '@/lib/messages';

interface CopyToClipboardButtonProps {
  bookId: string;
  field: string;
  value: string;
  /** コピー完了後に親へ通知 (楽観的 UI 更新) */
  onCopied?: () => void;
  /** 一括コピーボタン用テキスト上書き */
  label?: string;
  ariaLabel?: string;
  className?: string;
}

const m = messages.kdpChecklist;

export function CopyToClipboardButton({
  bookId,
  field,
  value,
  onCopied,
  label,
  ariaLabel,
  className,
}: CopyToClipboardButtonProps) {
  const [copied, setCopied] = useState(false);
  const [, startTransition] = useTransition();

  const handleCopy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      // Optimistic update to parent
      onCopied?.();
      // Persist to DB
      startTransition(async () => {
        await updateChecklist({ book_id: bookId, field, copied: true, checked: true });
      });
      // Reset feedback after 1.5s
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API may be unavailable in insecure context — silent fail
    }
  };

  const displayLabel = label ?? (copied ? m.copySuccess : 'コピー');

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={ariaLabel ?? m.copyAriaLabel(field)}
      className={`
        inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center
        gap-1 rounded-card border border-border-warm bg-cream px-2 py-1
        text-button-sm text-charcoal
        hover:bg-charcoal-04
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent
        ${copied ? 'border-success text-success' : ''}
        ${className ?? ''}
      `}
      data-testid={`copy-btn-${field}`}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span className="sr-only sm:not-sr-only">{displayLabel}</span>
    </button>
  );
}

function CopyIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
