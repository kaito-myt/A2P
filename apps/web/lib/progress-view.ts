/**
 * F-054 — パイプライン進行状況の算出ヘルパ (RSC/クライアント共有)。
 *
 * Book.status と章の進捗から「今どの段階か・何%か」を出す。停滞 (idle) 検知も含む。
 */

/** パイプラインの段階 (実行順)。 */
export const PIPELINE_PHASES = [
  { key: 'planning', label: '企画・アウトライン' },
  { key: 'writing', label: '本文執筆' },
  { key: 'editing', label: '編集・校正' },
  { key: 'thumbnail', label: '表紙・サムネ' },
  { key: 'judging', label: '品質評価' },
  { key: 'exporting', label: '書き出し' },
] as const;

export type PhaseKey = (typeof PIPELINE_PHASES)[number]['key'];

/** Book.status → 現在フェーズ index。 */
export function statusToPhaseIndex(status: string): number {
  switch (status) {
    case 'queued':
      return 0;
    case 'running':
      return 1; // 本文執筆中
    case 'editing':
      return 2;
    case 'thumbnail':
      return 3;
    case 'judging':
      return 4;
    case 'exporting':
      return 5;
    default:
      return 0;
  }
}

export interface BookProgressInput {
  id: string;
  title: string;
  status: string;
  updatedAtMs: number;
  nowMs: number;
  chaptersDone: number;
  chaptersTotal: number | null;
  latestJobKind: string | null;
  latestJobStatus: string | null;
  latestJobError: string | null;
}

export interface BookProgress {
  id: string;
  title: string;
  status: string;
  phaseIndex: number;
  phaseLabel: string;
  percent: number;
  chaptersDone: number;
  chaptersTotal: number | null;
  idleMinutes: number;
  /** 一定時間 (既定30分) 進捗がなく最後のジョブが失敗 → 停滞とみなす。 */
  stalled: boolean;
  stalledReason: string | null;
}

const STALL_MINUTES = 30;

export function computeBookProgress(input: BookProgressInput): BookProgress {
  const phaseIndex = statusToPhaseIndex(input.status);
  const total = PIPELINE_PHASES.length;

  // 執筆フェーズは章の進捗をサブ進捗として加味する。
  let sub = 0;
  if (input.status === 'running' && input.chaptersTotal && input.chaptersTotal > 0) {
    sub = Math.min(1, input.chaptersDone / input.chaptersTotal);
  }
  const percent = Math.round(((phaseIndex + sub) / total) * 100);

  const idleMinutes = Math.max(0, Math.round((input.nowMs - input.updatedAtMs) / 60000));
  const jobFailed = input.latestJobStatus === 'failed';
  const stalled = idleMinutes >= STALL_MINUTES && (jobFailed || idleMinutes >= 6 * 60);
  const stalledReason = stalled
    ? jobFailed
      ? `${(input.latestJobKind ?? 'job').replace('pipeline.book.', '')} が失敗: ${(input.latestJobError ?? '').slice(0, 120)}`
      : `${idleMinutes}分間 進捗なし`
    : null;

  return {
    id: input.id,
    title: input.title,
    status: input.status,
    phaseIndex,
    phaseLabel: PIPELINE_PHASES[phaseIndex]?.label ?? '—',
    percent,
    chaptersDone: input.chaptersDone,
    chaptersTotal: input.chaptersTotal,
    idleMinutes,
    stalled,
    stalledReason,
  };
}

/** テーマ生成中セッションの表示用。 */
export interface ThemeGenerating {
  sessionId: string;
  accountName: string | null;
  startedMinutes: number;
}
