/**
 * `pg_notify('jobs', payload)` 発火ヘルパ (T-03-11, docs/05 §1.4 / §5.2 / ADR-001).
 *
 * worker タスクが `Job.status` を遷移させた直後に呼び出して、
 * `/api/sse/jobs` を購読中のクライアントに状態変化を流す.
 *
 * 設計指針:
 *   - notify 失敗は **本処理に影響させない** (warn ログのみで握りつぶす).
 *     SSE は best-effort. UI 側は再オープン時に最新値を 1 回 GET する設計
 *     (docs/05 §1.4) のため、欠落しても整合性は崩れない.
 *   - Prisma シングルトン (`@a2p/db`) 経由で `$executeRawUnsafe` を呼ぶ.
 *     パラメータバインド (`$1`, `$2`) でチャネル名と JSON 文字列を渡す.
 *   - payload には常に `updated_at` (ISO 8601) を自動付与する.
 *
 * テストは `prisma` モックを受け取って呼出引数を検証する.
 */
import type { Logger } from '@a2p/contracts/logger';

/** docs/05 §1.4 / §5.2 / §7 / ADR-001 で確定した LISTEN チャンネル名. */
export const JOB_NOTIFY_CHANNEL = 'jobs';

/**
 * SSE で送る最小ペイロード. UI 側でジョブ進捗を描画するのに十分な粒度.
 * docs/05 §4.2.1 SseJobEvent (`type: 'job.update'`) のサブセット.
 */
export interface JobChangeNotifyPayload {
  /** Job.id (cuid). */
  jobId: string;
  /** queued | running | done | failed | cancelled. */
  status: string;
  /** task identifier 例: `pipeline.book.kickoff`. */
  kind: string;
  /** 関連書籍 ID. 無ければ省略可. */
  bookId?: string;
  /**
   * パイプラインの追加情報フラグ. 例: `awaiting_outline_approval` (T-04-04 で
   * outline を pending_review 状態で保存し、ユーザー承認待ちで停止したことを
   * UI に伝える). 省略時は JSON に含めない (既存購読側に影響しない).
   */
  phase?: string;
}

/** Prisma 最小サブセット I/F (テスト容易性のため). */
export interface NotifyJobChangePrisma {
  $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number>;
}

export interface NotifyJobChangeDeps {
  prisma: NotifyJobChangePrisma;
  logger?: Logger;
  /** 'now' 差替え (テスト固定用). */
  now?: () => Date;
}

/**
 * `pg_notify(channel, json)` を発火する. 失敗時は warn のみで継続.
 *
 * 戻り値の `ok` は副作用解析用 (テストで warn 経路を区別するため):
 *   - true  : pg_notify SQL が成功 (購読側に届く前提)
 *   - false : 例外発生 → warn ログ済, 例外は throw しない
 */
export async function notifyJobChange(
  payload: JobChangeNotifyPayload,
  deps: NotifyJobChangeDeps,
): Promise<{ ok: boolean }> {
  const { prisma, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const enriched = {
    jobId: payload.jobId,
    status: payload.status,
    kind: payload.kind,
    ...(payload.bookId != null ? { bookId: payload.bookId } : {}),
    ...(payload.phase != null ? { phase: payload.phase } : {}),
    updated_at: now().toISOString(),
  };

  try {
    await prisma.$executeRawUnsafe(
      'SELECT pg_notify($1, $2)',
      JOB_NOTIFY_CHANNEL,
      JSON.stringify(enriched),
    );
    return { ok: true };
  } catch (err) {
    logger?.warn(
      {
        channel: JOB_NOTIFY_CHANNEL,
        jobId: payload.jobId,
        status: payload.status,
        kind: payload.kind,
        err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      },
      'pg_notify failed (continuing — SSE is best-effort)',
    );
    return { ok: false };
  }
}
