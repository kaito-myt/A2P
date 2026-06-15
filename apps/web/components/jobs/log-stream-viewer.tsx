'use client';

/**
 * LogStreamViewer — 実行ログ表示エリア (S-026, T-09-02, F-045).
 *
 * Phase 1 では行単位のジョブログストアは存在しないため、
 * SSE (GET /api/sse/jobs?bookId=...) を購読して Job のステータス変化を
 * ターミナル風に表示する。
 *
 * 詳細な行単位ログ (worker stdout) の保存は Phase 2 以降の設計変更が必要。
 * その旨をUIで明示し、ユーザーが混乱しないようにする。
 *
 * 仕様根拠: docs/wireframes/S-026-job-detail/prompt.md §Section 4
 *           docs/05 §1.4 SSE / ADR-001
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { Download } from 'lucide-react';

import { messages } from '@/lib/messages';

const m = messages.jobs.detail;

interface LogLine {
  ts: string;
  level: 'info' | 'debug' | 'warn' | 'error';
  message: string;
}

interface LogStreamViewerProps {
  jobId: string;
  bookId: string | null;
  initialStatus: string;
  startedAt: string | null;
  finishedAt: string | null;
}

function now(): string {
  return new Date().toLocaleTimeString('ja-JP', { hour12: false });
}

function levelClass(level: LogLine['level']): string {
  switch (level) {
    case 'error':
      return 'text-red-400';
    case 'warn':
      return 'text-yellow-400';
    case 'debug':
      return 'text-gray-400';
    default:
      return 'text-green-300';
  }
}

export function LogStreamViewer({
  jobId,
  bookId,
  initialStatus,
  startedAt,
  finishedAt,
}: LogStreamViewerProps) {
  const [lines, setLines] = useState<LogLine[]>(() => {
    const initial: LogLine[] = [
      { ts: now(), level: 'info', message: `[システム] ジョブ ${jobId.slice(0, 12)}… を読込み中` },
    ];
    if (startedAt) {
      initial.push({ ts: new Date(startedAt).toLocaleTimeString('ja-JP', { hour12: false }), level: 'info', message: `[システム] ジョブ開始 (status: ${initialStatus})` });
    }
    if (finishedAt) {
      initial.push({ ts: new Date(finishedAt).toLocaleTimeString('ja-JP', { hour12: false }), level: initialStatus === 'failed' ? 'error' : 'info', message: `[システム] ジョブ終了 (status: ${initialStatus})` });
    }
    return initial;
  });

  const [autoScroll, setAutoScroll] = useState(true);
  const [liveStatus, setLiveStatus] = useState(initialStatus);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isTerminal = ['done', 'failed', 'cancelled'].includes(initialStatus);

  // SSE subscription for live status updates
  useEffect(() => {
    if (isTerminal) return;

    const url = bookId
      ? `/api/sse/jobs?bookId=${encodeURIComponent(bookId)}`
      : '/api/sse/jobs';

    const es = new EventSource(url);

    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const data = JSON.parse(e.data) as {
          jobId?: string;
          bookId?: string;
          status?: string;
          kind?: string;
        };
        // Filter to this job's events only
        if (data.jobId && data.jobId !== jobId) return;
        if (data.status) {
          setLiveStatus(data.status);
          setLines((prev) => [
            ...prev,
            {
              ts: now(),
              level: data.status === 'failed' ? 'error' : 'info',
              message: `[ライブ] ステータス更新: ${data.status}${data.kind ? ` (${data.kind})` : ''}`,
            },
          ]);
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      setLines((prev) => [
        ...prev,
        { ts: now(), level: 'warn', message: '[システム] SSE 接続が切断されました。再接続中...' },
      ]);
    };

    return () => {
      es.close();
    };
  }, [jobId, bookId, isTerminal]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const handleDownload = useCallback(() => {
    const text = lines.map((l) => `${l.ts} [${l.level.toUpperCase()}] ${l.message}`).join('\n');
    const blob = new Blob([text], { type: 'text/plain; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `job-${jobId.slice(0, 12)}-log.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [lines, jobId]);

  const isEmpty = lines.length === 0;

  return (
    <section aria-label={m.logSection} className="rounded-card border border-border-warm bg-white">
      <div className="flex items-center justify-between border-b border-border-warm px-space-normal py-space-snug">
        <h2 className="text-body font-medium text-foreground">{m.logSection}</h2>
        <div className="flex items-center gap-2">
          {!isTerminal && (
            <span className="text-caption text-accent" aria-live="polite">
              {m.liveUpdating}
            </span>
          )}
          <button
            type="button"
            className="rounded px-2 py-0.5 text-caption text-muted hover:bg-cream-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => setAutoScroll((v) => !v)}
            aria-pressed={autoScroll}
          >
            {autoScroll ? m.autoScrollOn : m.autoScrollOff}
          </button>
          <button
            type="button"
            className="flex items-center gap-1 rounded px-2 py-0.5 text-caption text-muted hover:bg-cream-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={handleDownload}
            aria-label={m.download}
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{m.download}</span>
          </button>
        </div>
      </div>

      {/* Phase 1 log limitation note */}
      <div className="border-b border-border-warm bg-amber-50 px-space-normal py-1.5">
        <p className="text-caption text-amber-700">{m.logNote}</p>
      </div>

      {isEmpty ? (
        <div className="flex flex-col items-center justify-center p-space-loose text-center">
          <p className="text-body text-muted">{m.logEmpty}</p>
          <p className="mt-1 text-caption text-muted">{m.logEmptyHint}</p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="h-64 overflow-y-auto bg-gray-900 p-space-normal font-mono text-caption leading-relaxed"
          style={{ fontFamily: 'monospace' }}
          role="log"
          aria-live="polite"
          aria-label="実行ログ"
        >
          {lines.map((line, i) => (
            <div key={i} className="flex gap-2">
              <span className="shrink-0 text-gray-500 tabular-nums">{line.ts}</span>
              <span className={`shrink-0 ${levelClass(line.level)}`}>
                [{line.level.toUpperCase()}]
              </span>
              <span className={line.level === 'error' ? 'text-red-300' : 'text-gray-200'}>
                {line.message}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-border-warm px-space-normal py-1.5">
        <span className="text-caption text-muted">
          ステータス: <span className="font-medium">{liveStatus}</span>
        </span>
      </div>
    </section>
  );
}
