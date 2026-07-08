/**
 * F-054 — computeBookProgress の単体テスト。
 */
import { describe, expect, it } from 'vitest';

import { computeBookProgress, statusToPhaseIndex } from '../../lib/progress-view';

const base = {
  id: 'b1',
  title: '本',
  updatedAtMs: 1_000_000,
  nowMs: 1_000_000,
  chaptersDone: 0,
  chaptersTotal: null as number | null,
  latestJobKind: null as string | null,
  latestJobStatus: null as string | null,
  latestJobError: null as string | null,
};

describe('statusToPhaseIndex', () => {
  it('maps statuses to ordered phases', () => {
    expect(statusToPhaseIndex('running')).toBe(1);
    expect(statusToPhaseIndex('editing')).toBe(2);
    expect(statusToPhaseIndex('exporting')).toBe(5);
  });
});

describe('computeBookProgress', () => {
  it('執筆中は章の進捗をサブ進捗に加味する (9/10 → 31%)', () => {
    const p = computeBookProgress({ ...base, status: 'running', chaptersDone: 9, chaptersTotal: 10 });
    expect(p.phaseLabel).toBe('本文執筆');
    // (1 + 0.9)/6 = 31.7 → 32
    expect(p.percent).toBe(32);
    expect(p.chaptersDone).toBe(9);
  });

  it('最終ジョブ失敗 + 30分以上放置で停滞と判定', () => {
    const now = 1_000_000 + 40 * 60_000;
    const p = computeBookProgress({
      ...base,
      status: 'running',
      nowMs: now,
      chaptersDone: 9,
      chaptersTotal: 10,
      latestJobKind: 'pipeline.book.writer.chapter',
      latestJobStatus: 'failed',
      latestJobError: 'AgentError: writer.chapter.chars_out_of_range',
    });
    expect(p.stalled).toBe(true);
    expect(p.stalledReason).toContain('writer.chapter');
    expect(p.idleMinutes).toBe(40);
  });

  it('直近更新で失敗なし → 停滞ではない', () => {
    const p = computeBookProgress({ ...base, status: 'editing', nowMs: 1_000_000 + 5 * 60_000 });
    expect(p.stalled).toBe(false);
    expect(p.phaseLabel).toBe('編集・校正');
  });

  it('6時間以上放置は失敗ジョブが無くても停滞', () => {
    const p = computeBookProgress({ ...base, status: 'running', nowMs: 1_000_000 + 7 * 60 * 60_000, chaptersDone: 3, chaptersTotal: 10 });
    expect(p.stalled).toBe(true);
    expect(p.stalledReason).toContain('進捗なし');
  });
});
