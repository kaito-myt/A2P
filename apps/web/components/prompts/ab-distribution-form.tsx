'use client';

/**
 * AbDistributionForm — A/B 配信設定フォーム (T-11-08, F-031).
 *
 * - baseline_id セレクト: 同 role×genre の archived prompt 候補
 * - candidate_id セレクト: 同 role×genre の archived/active prompt 候補
 * - ratio_candidate スライダー: 0.0〜1.0, step 0.1, 既定 0.5
 * - [A/B 配信を開始] ボタン → startAbDistribution SA
 * - 配信中は現設定表示 + [A/B 配信を停止]（ratio_candidate=0 で上書き）
 * - [A/B 統計結果へ] リンク: SP-13 未実装のためグレーアウト
 *
 * 仕様根拠: SP-11 T-11-08 / docs/wireframes/S-022 Section 5
 */
import { useState, useCallback, useTransition } from 'react';
import Link from 'next/link';

import { startAbDistribution } from '@/app/actions/prompt-proposals';
import { messages } from '@/lib/messages';
import { normalizeAbGenre, type AbDistributionConfig } from '@/lib/ab-distribution-shared';
import type { PromptListItem } from '@/lib/prompts-view';
import { Button } from '@/components/ui/button';

const m = messages.prompts.ab;

export interface AbDistributionFormProps {
  role: string;
  genre: string | null;
  current: AbDistributionConfig | null;
  candidates: PromptListItem[];
}

function versionLabel(item: PromptListItem): string {
  return `v${item.version} (${item.status})`;
}

export function AbDistributionForm({
  role,
  genre,
  current,
  candidates,
}: AbDistributionFormProps) {
  const [baselineId, setBaselineId] = useState<string>(current?.baseline_id ?? '');
  const [candidateId, setCandidateId] = useState<string>(current?.candidate_id ?? '');
  const [ratio, setRatio] = useState<number>(current?.ratio_candidate ?? 0.5);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleStart = useCallback(() => {
    if (!baselineId || !candidateId) {
      setFeedback({ ok: false, msg: m.errors.noPrompts });
      return;
    }
    startTransition(async () => {
      const result = await startAbDistribution({
        role,
        genre: normalizeAbGenre(genre),
        baseline_id: baselineId,
        candidate_id: candidateId,
        ratio_candidate: ratio,
      });
      if (result.ok) {
        setFeedback({ ok: true, msg: m.startSuccess });
      } else {
        setFeedback({
          ok: false,
          msg: result.error.code === 'validation' ? m.errors.validation : m.errors.unknown,
        });
      }
    });
  }, [role, genre, baselineId, candidateId, ratio]);

  const handleStop = useCallback(() => {
    if (!current) return;
    startTransition(async () => {
      const result = await startAbDistribution({
        role,
        genre: normalizeAbGenre(genre),
        baseline_id: current.baseline_id,
        candidate_id: current.candidate_id,
        ratio_candidate: 0,
      });
      if (result.ok) {
        setFeedback({ ok: true, msg: m.stopSuccess });
        setRatio(0);
      } else {
        setFeedback({
          ok: false,
          msg: m.errors.unknown,
        });
      }
    });
  }, [role, genre, current]);

  const isRunning = current !== null && current.ratio_candidate > 0;

  return (
    <div
      className="flex flex-col gap-space-snug"
      data-testid="ab-distribution-form"
    >
      <h3 className="text-card-title font-medium text-foreground">{m.sectionTitle}</h3>

      {/* 現在の配信状況 */}
      {isRunning && current && (
        <div
          data-testid="ab-current-config"
          className="rounded-card border border-border-warm bg-cream-light p-space-snug text-body"
        >
          <p className="font-medium text-foreground">{m.currentConfig}</p>
          <p className="text-muted">{m.configBaseline(current.baseline_id)}</p>
          <p className="text-muted">{m.configCandidate(current.candidate_id)}</p>
          <p className="text-muted">{m.configRatio(current.ratio_candidate)}</p>
        </div>
      )}

      {!isRunning && (
        <p className="text-body text-muted" data-testid="ab-not-running">
          {m.notRunning}
        </p>
      )}

      {candidates.length === 0 ? (
        <p className="text-body text-muted">{m.noPrompts}</p>
      ) : (
        <div className="flex flex-col gap-space-snug">
          {/* 基準版セレクト */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor="ab-baseline-id"
              className="text-button-sm font-medium text-foreground"
            >
              {m.baselineLabel}
            </label>
            <select
              id="ab-baseline-id"
              data-testid="ab-baseline-select"
              value={baselineId}
              onChange={(e) => setBaselineId(e.target.value)}
              className="rounded-default border border-charcoal-40 bg-white px-3 py-2 text-body text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              disabled={isPending}
            >
              <option value="">{m.selectPlaceholder}</option>
              {candidates
                .filter((c) => c.status === 'archived')
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {versionLabel(c)}
                  </option>
                ))}
            </select>
          </div>

          {/* 候補版セレクト */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor="ab-candidate-id"
              className="text-button-sm font-medium text-foreground"
            >
              {m.candidateLabel}
            </label>
            <select
              id="ab-candidate-id"
              data-testid="ab-candidate-select"
              value={candidateId}
              onChange={(e) => setCandidateId(e.target.value)}
              className="rounded-default border border-charcoal-40 bg-white px-3 py-2 text-body text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
              disabled={isPending}
            >
              <option value="">{m.selectPlaceholder}</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {versionLabel(c)}
                </option>
              ))}
            </select>
          </div>

          {/* 配信比率スライダー */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor="ab-ratio"
              className="text-button-sm font-medium text-foreground"
            >
              {m.ratioLabel}
            </label>
            <input
              id="ab-ratio"
              data-testid="ab-ratio-slider"
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={ratio}
              onChange={(e) => setRatio(parseFloat(e.target.value))}
              disabled={isPending}
              className="w-full accent-charcoal disabled:opacity-50"
            />
            <p className="text-button-sm text-muted">{m.ratioHint(ratio)}</p>
          </div>

          {/* アクションボタン */}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              data-testid="ab-start-button"
              onClick={handleStart}
              disabled={isPending}
            >
              {isPending ? m.starting : m.startButton}
            </Button>

            {isRunning && (
              <Button
                type="button"
                variant="destructive"
                data-testid="ab-stop-button"
                onClick={handleStop}
                disabled={isPending}
              >
                {isPending ? m.stopping : m.stopButton}
              </Button>
            )}

            {/* A/B 統計結果へ — SP-13 未実装のためグレーアウト */}
            <Link
              href="/models/ab"
              aria-disabled="true"
              tabIndex={-1}
              data-testid="ab-stats-link"
              className="inline-flex cursor-not-allowed items-center rounded-default border border-charcoal-40 px-4 py-2 text-button text-muted opacity-50"
              onClick={(e) => e.preventDefault()}
              title={m.statsLinkDisabled}
            >
              {m.statsLink}
            </Link>
          </div>
        </div>
      )}

      {/* フィードバック */}
      {feedback && (
        <p
          data-testid="ab-feedback"
          className={`text-body ${feedback.ok ? 'text-green-700' : 'text-destructive'}`}
        >
          {feedback.msg}
        </p>
      )}
    </div>
  );
}
