'use client';

/**
 * ErrorDetail — エラー詳細折りたたみ (S-026, T-09-02).
 *
 * status=failed の時のみエラーメッセージ + スタックトレースを展開表示。
 * Playwright ジョブ (Phase 3) のスクリーンショットは artifact が存在する場合のみ表示。
 * それ以外は "エラーなし" バッジを表示。
 *
 * 仕様根拠: docs/wireframes/S-026-job-detail/prompt.md §Section 5
 */
import { useState } from 'react';
import { AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';

import { messages } from '@/lib/messages';

const m = messages.jobs.detail;

interface ErrorDetailProps {
  status: string;
  error: string | null;
  screenshotUrl?: string | null;
}

function parseErrorAndStack(raw: string): { message: string; stack: string | null } {
  const newlineIdx = raw.indexOf('\n');
  if (newlineIdx === -1) {
    return { message: raw, stack: null };
  }
  return { message: raw.slice(0, newlineIdx), stack: raw.slice(newlineIdx + 1) };
}

export function ErrorDetail({ status, error, screenshotUrl }: ErrorDetailProps) {
  const [open, setOpen] = useState(status === 'failed');

  const isFailed = status === 'failed';

  return (
    <section
      aria-label={m.errorSection}
      className={`rounded-card border bg-white ${isFailed ? 'border-red-300' : 'border-border-warm'}`}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between px-space-normal py-space-snug text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="error-detail-content"
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted" aria-hidden="true" />
          )}
          <span className="text-body font-medium text-foreground">{m.errorSection}</span>
        </div>

        {!isFailed && (
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-caption text-green-800">
            {m.errorNone}
          </span>
        )}
        {isFailed && (
          <AlertCircle className="h-4 w-4 text-red-600" aria-hidden="true" aria-label="エラーあり" />
        )}
      </button>

      {open && (
        <div
          id="error-detail-content"
          className="border-t border-border-warm px-space-normal py-space-snug"
        >
          {!isFailed || !error ? (
            <p className="text-body text-muted">{m.errorNone}</p>
          ) : (
            <div className="flex flex-col gap-space-snug">
              {/* Error message */}
              <div>
                <p className="text-caption font-medium text-muted">{m.errorMessage}</p>
                <p className="mt-1 text-body text-red-700 break-all">
                  {parseErrorAndStack(error).message}
                </p>
              </div>

              {/* Stack trace */}
              {parseErrorAndStack(error).stack && (
                <div>
                  <p className="text-caption font-medium text-muted">{m.stackTrace}</p>
                  <pre
                    className="mt-1 overflow-x-auto rounded bg-red-50 p-space-snug text-caption text-red-800"
                    style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                  >
                    {parseErrorAndStack(error).stack}
                  </pre>
                </div>
              )}

              {/* Screenshot (Phase 3 Playwright jobs) */}
              {screenshotUrl && (
                <div>
                  <p className="text-caption font-medium text-muted">{m.screenshot}</p>
                  <div className="mt-1 overflow-hidden rounded border border-border-warm">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={screenshotUrl}
                      alt="ジョブ失敗時スクリーンショット"
                      className="max-w-full"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
