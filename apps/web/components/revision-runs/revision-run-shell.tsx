'use client';

/**
 * S-014 修正一括反映 Client Shell (T-06-09, T-06-10).
 *
 * RunHeader + GlobalProgressBar + BookProgressCardList を常時表示。
 * 完了後 (done/partial/failed) は DiffReviewer + CostRecordTable を追加表示。
 * ActionBar は常時下部固定。
 *
 * SSE 購読 (T-06-10): run が queued/running の場合、
 * `/api/sse/revision-runs/[id]` に接続してリアルタイム進捗を受信。
 * `event: done` 受信時に SSE を close し `router.refresh()` で最終データ取得。
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { messages } from '@/lib/messages';
import type { RevisionRunSerialized, RunStatus } from '@/lib/revision-runs-view';
import { computeRunProgress, computeBookProgress } from '@/lib/revision-runs-view';

import { RunHeader } from './run-header';
import { GlobalProgressBar } from './global-progress-bar';
import { BookProgressCardList } from './book-progress-card-list';
import { DiffReviewer } from './diff-reviewer';
import { CostRecordTable } from './cost-record-table';
import { ActionBar } from './action-bar';

const m = messages.revisionRuns;

interface SseProgress {
  applied: number;
  not_applicable: number;
  total: number;
}

interface RevisionRunShellProps {
  run: RevisionRunSerialized;
}

export function RevisionRunShell({ run }: RevisionRunShellProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('diff');
  const [sseProgress, setSseProgress] = useState<SseProgress | null>(null);
  const [sseStatus, setSseStatus] = useState<RunStatus>(run.status);
  const eventSourceRef = useRef<EventSource | null>(null);

  const isLive = run.status === 'queued' || run.status === 'running';

  const handleDone = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    router.refresh();
  }, [router]);

  useEffect(() => {
    if (!isLive) return;

    const es = new EventSource(`/api/sse/revision-runs/${run.id}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>;
        setSseProgress({
          applied: typeof data.applied === 'number' ? data.applied : 0,
          not_applicable: typeof data.not_applicable === 'number' ? data.not_applicable : 0,
          total: typeof data.total === 'number' ? data.total : 0,
        });
        setSseStatus('running');
      } catch {
        // ignore non-JSON data
      }
    };

    es.addEventListener('done', (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as Record<string, unknown>;
        const status = typeof data.status === 'string' ? data.status : 'done';
        setSseStatus(status as RunStatus);
      } catch {
        setSseStatus('done');
      }
      handleDone();
    });

    es.onerror = () => {
      // SSE reconnect is handled automatically by EventSource
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [isLive, run.id, handleDone]);

  const serverProgress = computeRunProgress(run.comments);
  const progress = sseProgress
    ? {
        total: sseProgress.total,
        applied: sseProgress.applied,
        not_applicable: sseProgress.not_applicable,
        pending: Math.max(0, sseProgress.total - sseProgress.applied - sseProgress.not_applicable),
        percent: sseProgress.total > 0
          ? Math.round(
              ((sseProgress.applied + sseProgress.not_applicable) / sseProgress.total) * 100,
            )
          : 0,
      }
    : serverProgress;

  const currentStatus = isLive ? sseStatus : run.status;
  const bookProgress = computeBookProgress(run.comments, run.books);
  const isComplete = currentStatus === 'done' || currentStatus === 'partial' || currentStatus === 'failed';
  const firstBookId = run.book_ids[0] ?? null;

  const displayRun = { ...run, status: currentStatus };

  return (
    <div className="flex flex-col gap-space-loose" data-testid="revision-run-shell">
      <RunHeader run={displayRun} />

      <GlobalProgressBar progress={progress} status={currentStatus} />

      <BookProgressCardList bookProgress={bookProgress} />

      {isComplete && (
        <Tabs value={activeTab} onValueChange={setActiveTab} data-testid="revision-run-tabs">
          <TabsList className="flex-wrap" data-testid="revision-run-tabs-list">
            <TabsTrigger value="diff" data-testid="tab-diff">
              {m.diff.tabLabel}
            </TabsTrigger>
            <TabsTrigger value="cost" data-testid="tab-cost">
              {m.cost.sectionTitle}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="diff">
            <DiffReviewer
              comments={run.comments}
              chapterDiffs={run.chapter_diffs}
            />
          </TabsContent>

          <TabsContent value="cost">
            <CostRecordTable
              costRows={run.cost_rows}
              totalJpy={run.cost_total_jpy}
            />
          </TabsContent>
        </Tabs>
      )}

      <ActionBar
        runStatus={currentStatus}
        firstBookId={firstBookId}
        runId={run.id}
      />
    </div>
  );
}
