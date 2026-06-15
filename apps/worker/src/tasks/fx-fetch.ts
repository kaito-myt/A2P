import type { JobHelpers, Task } from 'graphile-worker';

import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma, Prisma } from '@a2p/db';

/**
 * `fx.fetch` タスク (T-02-08, docs/05 §5.3.13 / docs/03 §B-04)
 *
 * `FX_RATE_API_URL` (既定 `https://open.er-api.com/v6/latest/USD`) から USD/JPY 為替レートを
 * 日次取得し、`AppSettings.latest_fx_rate` に保存する。catalog.fetch (T-02-09) が
 * `fx_rate_usd_jpy` として参照する基準値となる。
 *
 * 失敗時 (HTTP error / JSON parse error / `result !== 'success'` / rates.JPY 欠落) は
 *   - 既存の `latest_fx_rate` を変更しない (= 前回値継続)
 *   - `Alert` テーブルに `fx_fetch_failed` を INSERT (運営者へ通知用)
 *   - graphile-worker には throw せず正常終了 (次回 cron で再試行、リトライ不要)
 *
 * cron は crontab.ts で `55 18 * * *` (JST 03:55) 発火。
 */

export const FX_FETCH_TASK_NAME = 'fx.fetch';

/** open.er-api.com v6 のレスポンス形状 (必要最小限のみ型付け)。 */
interface FxApiResponse {
  result?: string;
  base_code?: string;
  rates?: Record<string, number>;
  time_last_update_unix?: number;
}

/**
 * AppSettings 永続化に必要な Prisma 部分インターフェース。
 * テストで mock しやすいよう最小サブセットだけ要求する。
 */
export interface FxFetchPrisma {
  appSettings: {
    update: (args: {
      where: { id: string };
      data: { latest_fx_rate: Prisma.Decimal };
    }) => Promise<unknown>;
  };
  alert: {
    create: (args: {
      data: {
        kind: string;
        severity: string;
        payload_json: Prisma.InputJsonValue;
      };
    }) => Promise<unknown>;
  };
}

export interface FxFetchDeps {
  /** 差し替え用 (テスト)。本番は `@a2p/db` のシングルトン。 */
  prisma?: FxFetchPrisma;
  /** `fetch` 差し替え (テスト)。既定は `globalThis.fetch`。 */
  fetchImpl?: typeof globalThis.fetch;
  /** API エンドポイント。既定は `process.env.FX_RATE_API_URL` または公式 URL。 */
  apiUrl?: string;
  /** ロガー差し替え。 */
  logger?: Logger;
  /** 「今」を固定するフック (テスト用)。 */
  now?: () => Date;
}

export interface FxFetchResult {
  /** 取得成功 = true / 失敗継続 = false。 */
  ok: boolean;
  /** 取得成功時のレート。失敗時は null。 */
  rate: number | null;
  /** API の time_last_update_unix (UTC seconds)。 */
  apiUpdatedAt: number | null;
}

const DEFAULT_FX_API_URL = 'https://open.er-api.com/v6/latest/USD';

/**
 * テストから直接呼べる純粋ヘルパ。graphile-worker の Task ラッパとは分離。
 *
 * 失敗時も throw せず `{ ok: false }` を返す (cron は次回再試行で十分なため
 * graphile-worker のリトライ機構には乗せない設計判断)。
 */
export async function runFxFetch(deps: FxFetchDeps = {}): Promise<FxFetchResult> {
  const log = deps.logger ?? createLogger(`worker.${FX_FETCH_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as FxFetchPrisma);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const apiUrl = deps.apiUrl ?? process.env.FX_RATE_API_URL ?? DEFAULT_FX_API_URL;
  const now = deps.now ?? (() => new Date());

  log.info({ task: FX_FETCH_TASK_NAME, apiUrl }, 'fx fetch start');

  let parsed: FxApiResponse | null = null;
  let failureReason: string | null = null;
  let httpStatus: number | null = null;

  try {
    const response = await fetchImpl(apiUrl);
    httpStatus = response.status;
    if (!response.ok) {
      failureReason = `http_error_${response.status}`;
    } else {
      try {
        parsed = (await response.json()) as FxApiResponse;
      } catch (err) {
        failureReason = 'json_parse_error';
        log.warn({ task: FX_FETCH_TASK_NAME, err }, 'fx fetch JSON parse failed');
      }
    }
  } catch (err) {
    failureReason = 'network_error';
    log.warn({ task: FX_FETCH_TASK_NAME, err }, 'fx fetch network error');
  }

  if (!failureReason && parsed) {
    if (parsed.result !== 'success') {
      failureReason = `api_error_${parsed.result ?? 'unknown'}`;
    } else if (
      !parsed.rates ||
      typeof parsed.rates.JPY !== 'number' ||
      !Number.isFinite(parsed.rates.JPY) ||
      parsed.rates.JPY <= 0
    ) {
      failureReason = 'missing_jpy_rate';
    }
  }

  if (failureReason || !parsed?.rates?.JPY) {
    await recordFailure(prisma, log, {
      reason: failureReason ?? 'unknown',
      apiUrl,
      httpStatus,
      occurredAt: now(),
    });
    return { ok: false, rate: null, apiUpdatedAt: parsed?.time_last_update_unix ?? null };
  }

  const rate = parsed.rates.JPY;
  const apiUpdatedAt = parsed.time_last_update_unix ?? null;

  await prisma.appSettings.update({
    where: { id: 'singleton' },
    data: { latest_fx_rate: new Prisma.Decimal(rate) },
  });

  log.info(
    {
      task: FX_FETCH_TASK_NAME,
      rate,
      apiUpdatedAt,
      apiUpdatedAtIso: apiUpdatedAt ? new Date(apiUpdatedAt * 1000).toISOString() : null,
    },
    'fx fetch done',
  );

  return { ok: true, rate, apiUpdatedAt };
}

interface FailureContext {
  reason: string;
  apiUrl: string;
  httpStatus: number | null;
  occurredAt: Date;
}

async function recordFailure(
  prisma: FxFetchPrisma,
  log: Logger,
  ctx: FailureContext,
): Promise<void> {
  log.warn(
    {
      task: FX_FETCH_TASK_NAME,
      reason: ctx.reason,
      httpStatus: ctx.httpStatus,
      apiUrl: ctx.apiUrl,
    },
    'fx fetch failed; keeping previous latest_fx_rate and recording alert',
  );
  try {
    await prisma.alert.create({
      data: {
        kind: 'fx_fetch_failed',
        severity: 'warning',
        payload_json: {
          reason: ctx.reason,
          api_url: ctx.apiUrl,
          http_status: ctx.httpStatus,
          occurred_at: ctx.occurredAt.toISOString(),
        },
      },
    });
  } catch (alertErr) {
    // アラート INSERT 自体が失敗しても fx.fetch の責務外なので warn のみ。
    log.warn(
      { task: FX_FETCH_TASK_NAME, err: alertErr },
      'failed to insert fx_fetch_failed alert',
    );
  }
}

export const fxFetchTask: Task = async (_payload: unknown, _helpers: JobHelpers) => {
  await runFxFetch();
};
