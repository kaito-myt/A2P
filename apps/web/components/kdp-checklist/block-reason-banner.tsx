'use client';

/**
 * BlockReasonBanner — must コメント残時の赤バナー (T-08-03, F-049).
 *
 * カラーだけでなく XCircle アイコン + テキストでも識別できるようにする
 * (アクセシビリティガイドライン: color is not the sole indicator).
 */
import Link from 'next/link';

import { messages } from '@/lib/messages';
import type { MustCommentView } from '@/lib/kdp-checklist-view';

interface BlockReasonBannerProps {
  mustCommentCount: number;
  mustComments: MustCommentView[];
}

const m = messages.kdpChecklist;

export function BlockReasonBanner({ mustCommentCount, mustComments }: BlockReasonBannerProps) {
  return (
    <div
      role="alert"
      aria-live="polite"
      className="rounded-card border-2 border-destructive bg-destructive-bg p-space-snug"
      data-testid="block-reason-banner"
    >
      <div className="flex items-start gap-space-snug">
        <XCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
        <div className="flex min-w-0 flex-col gap-space-snug">
          <p className="font-medium text-destructive">
            {m.blockReasonTitle(mustCommentCount)}
          </p>

          {mustComments.length > 0 && (
            <ul className="ml-2 flex flex-col gap-0.5 text-body text-destructive">
              {mustComments.map((c) => (
                <li key={c.id} className="flex items-start gap-1">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" />
                  <span className="line-clamp-2">{c.body}</span>
                </li>
              ))}
            </ul>
          )}

          <Link
            href="/comments"
            className="self-start text-button-sm font-medium text-destructive underline underline-offset-4 hover:opacity-80"
            data-testid="block-banner-comments-link"
          >
            {m.blockReasonCta}
          </Link>
        </div>
      </div>
    </div>
  );
}

function XCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  );
}
