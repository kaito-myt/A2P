'use client';

/**
 * CostMeter -- Header 常時表示コンポーネント (T-07-06 / docs/04 §3.2).
 *
 * 当月コスト / 上限 (AppSettings.monthly_cost_red_jpy, default 50,000) を
 * プログレスバーで可視化。SSE (/api/sse/cost) で 5 秒以内に自動更新。
 * SSE 接続失敗時は /api/cost/current への 30 秒ポーリングにフォールバック。
 *
 * 色変化: 0-80% 緑 / 80-95% 黄 / 95-100% 橙 / 100%+ 赤
 * クリックで /cost (S-024) へ遷移。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { messages } from '@/lib/messages';
import type { CostLevel } from '@/lib/cost-meter-core';

const POLL_INTERVAL_MS = 30_000;
const SSE_ENDPOINT = '/api/sse/cost';
const POLL_ENDPOINT = '/api/cost/current';

const m = messages.header;

interface CostMeterState {
  monthly_cost_jpy: number;
  budget_jpy: number;
  ratio: number;
  level: CostLevel;
  remaining: number;
  warn_count: number;
  paused_count: number;
  loaded: boolean;
}

const INITIAL_STATE: CostMeterState = {
  monthly_cost_jpy: 0,
  budget_jpy: 50_000,
  ratio: 0,
  level: 'green',
  remaining: 50_000,
  warn_count: 0,
  paused_count: 0,
  loaded: false,
};

const LEVEL_COLORS: Record<CostLevel, { bar: string; text: string }> = {
  green: { bar: 'bg-success', text: 'text-success' },
  yellow: { bar: 'bg-warning', text: 'text-warning' },
  orange: { bar: 'bg-[#ea580c]', text: 'text-[#ea580c]' },
  red: { bar: 'bg-destructive', text: 'text-destructive' },
};

function applyPayload(
  raw: unknown,
  setState: React.Dispatch<React.SetStateAction<CostMeterState>>,
): void {
  if (typeof raw !== 'object' || raw === null) return;
  const d = raw as Record<string, unknown>;
  setState({
    monthly_cost_jpy: typeof d.monthly_cost_jpy === 'number' ? d.monthly_cost_jpy : 0,
    budget_jpy: typeof d.budget_jpy === 'number' ? d.budget_jpy : 50_000,
    ratio: typeof d.ratio === 'number' ? d.ratio : 0,
    level: (typeof d.level === 'string' ? d.level : 'green') as CostLevel,
    remaining: typeof d.remaining === 'number' ? d.remaining : 50_000,
    warn_count: typeof d.warn_count === 'number' ? d.warn_count : 0,
    paused_count: typeof d.paused_count === 'number' ? d.paused_count : 0,
    loaded: true,
  });
}

export function CostMeter() {
  const router = useRouter();
  const [state, setState] = useState<CostMeterState>(INITIAL_STATE);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchFallback = useCallback(async () => {
    try {
      const res = await fetch(POLL_ENDPOINT);
      if (!res.ok) return;
      const data: unknown = await res.json();
      applyPayload(data, setState);
    } catch {
      // silently ignore network errors during fallback polling
    }
  }, []);

  const startFallbackPolling = useCallback(() => {
    if (pollTimerRef.current != null) return;
    void fetchFallback();
    pollTimerRef.current = setInterval(() => {
      void fetchFallback();
    }, POLL_INTERVAL_MS);
  }, [fetchFallback]);

  const stopFallbackPolling = useCallback(() => {
    if (pollTimerRef.current != null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      // SSE not supported (SSR guard) — fall back to polling
      startFallbackPolling();
      return stopFallbackPolling;
    }

    const es = new EventSource(SSE_ENDPOINT);
    let sseErrored = false;

    es.onmessage = (event) => {
      try {
        const data: unknown = JSON.parse(event.data as string);
        applyPayload(data, setState);
      } catch {
        // malformed SSE payload — ignore
      }
    };

    es.onerror = () => {
      if (sseErrored) return;
      sseErrored = true;
      // SSE 接続失敗 → ポーリングへフォールバック
      es.close();
      startFallbackPolling();
    };

    return () => {
      es.close();
      stopFallbackPolling();
    };
  }, [startFallbackPolling, stopFallbackPolling]);

  const handleClick = useCallback(() => {
    router.push('/cost');
  }, [router]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    },
    [handleClick],
  );

  const colors = LEVEL_COLORS[state.level];
  const barWidth = Math.min(state.ratio, 100);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={m.costMeterLabel}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className="hidden cursor-pointer items-center gap-2 rounded-pill border border-border-warm bg-charcoal-04 px-3 py-1 text-button-sm text-charcoal-82 transition-colors hover:bg-charcoal-03 md:inline-flex"
    >
      <span className="whitespace-nowrap">{m.costMeterLabel}</span>

      {!state.loaded ? (
        <span className="font-medium text-charcoal-83">{m.costMeterFallback}</span>
      ) : (
        <div className="flex items-center gap-2">
          {/* Cost value */}
          <span className={`font-medium whitespace-nowrap ${colors.text}`}>
            ¥{state.monthly_cost_jpy.toLocaleString('ja-JP')}
          </span>

          {/* Progress bar */}
          <div
            className="relative h-2 w-16 overflow-hidden rounded-pill bg-charcoal-04"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(state.ratio)}
            role="progressbar"
          >
            <div
              className={`absolute inset-y-0 left-0 rounded-pill transition-all duration-500 ${colors.bar}`}
              style={{ width: `${barWidth}%` }}
            />
          </div>

          {/* Remaining / budget info */}
          <span className="whitespace-nowrap text-charcoal-40">
            {m.costMeterBudget(state.budget_jpy)}
          </span>

          {/* Warn/paused indicators */}
          {state.warn_count > 0 && (
            <span className="whitespace-nowrap text-warning">
              {m.costMeterWarn(state.warn_count)}
            </span>
          )}
          {state.paused_count > 0 && (
            <span className="whitespace-nowrap text-destructive">
              {m.costMeterPaused(state.paused_count)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
