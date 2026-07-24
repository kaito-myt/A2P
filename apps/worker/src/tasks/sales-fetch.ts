import { z } from 'zod';

import { createLogger, type Logger } from '@a2p/contracts/logger';
import { decryptKdpCredentials } from '@a2p/crypto';
import { prisma as defaultPrisma } from '@a2p/db';
import { parseKdpReportWorkbook, normalizeKdpRows } from '@a2p/kdp-report';

import type { BrowserPort } from './sales-fetch/browser-port.js';

/**
 * `sales.fetch` ワーカタスク (F-038, 自動取得 Phase2)。
 *
 * セッション再利用方式: accounts.kdp_session_state_enc(暗号化 storageState)を復号し、
 * `BrowserPort.downloadReport` で KDP 月別ロイヤリティ(PMR)レポート xlsx を取得 →
 * 共有パーサ(@a2p/kdp-report)で対象月を正規化 → ASIN 突合 → sales_records を upsert。
 *
 * source='auto'。運営者の手動確定値(source='manual_upload')は上書きしない。
 * BrowserPort を DI して実ブラウザなしで単体テスト可能。
 */

export const SALES_FETCH_TASK_NAME = 'sales.fetch';

/** 確定手動取込。自動取得はこれを上書きしない。 */
const PROTECTED_SOURCES = new Set(['manual_upload']);

// ---------------------------------------------------------------------------
// 公開型
// ---------------------------------------------------------------------------

export const SalesFetchPayload = z.object({
  account_id: z.string(),
  year_month: z.string().regex(/^\d{4}-\d{2}$/),
});
export type SalesFetchPayload = z.infer<typeof SalesFetchPayload>;

/** Prisma 最小インターフェース — テストでモック可能にする。 */
export interface SalesFetchPrisma {
  account: {
    findUnique(args: {
      where: { id: string };
      select: { kdp_session_state_enc: true };
    }): Promise<{ kdp_session_state_enc: string | null } | null>;
  };
  salesFetchRun: {
    create(args: {
      data: { account_id: string; year_month: string; status: string };
    }): Promise<{ id: string }>;
    update(args: {
      where: { id: string };
      data: {
        status: string;
        records_upserted?: number;
        error_message?: string | null;
        finished_at?: Date;
      };
    }): Promise<unknown>;
  };
  book: {
    findMany(args: {
      where: { asin: { in: string[] } };
      select: { id: true; asin: true };
    }): Promise<Array<{ id: string; asin: string | null }>>;
  };
  salesRecord: {
    findMany(args: {
      where: { book_id: { in: string[] }; year_month: string };
      select: { book_id: true; source: true };
    }): Promise<Array<{ book_id: string; source: string }>>;
    upsert(args: {
      where: { book_id_year_month: { book_id: string; year_month: string } };
      create: {
        book_id: string;
        year_month: string;
        royalty_jpy: number;
        units_sold: number;
        kenp_read: number;
        source: string;
      };
      update: {
        royalty_jpy: number;
        units_sold: number;
        kenp_read: number;
        source: string;
      };
    }): Promise<unknown>;
  };
  modelCatalog: {
    findFirst(args: {
      where: { is_current: boolean };
      select: { fx_rate_usd_jpy: true };
      orderBy: { fetched_at: 'desc' };
    }): Promise<{ fx_rate_usd_jpy: unknown } | null>;
  };
}

export interface SalesFetchDeps {
  payload: SalesFetchPayload;
  browserPort: BrowserPort;
  prisma?: SalesFetchPrisma;
  logger?: Logger;
  now?: () => Date;
}

export interface SalesFetchResult {
  ok: boolean;
  recordsUpserted: number;
  runId: string;
  reason?: 'session_expired' | 'no_session' | 'download_failed' | 'parse_error' | 'unknown';
}

// ---------------------------------------------------------------------------
// 純ロジック関数
// ---------------------------------------------------------------------------

export async function runSalesFetch(deps: SalesFetchDeps): Promise<SalesFetchResult> {
  const { payload } = deps;
  const log = deps.logger ?? createLogger(`worker.${SALES_FETCH_TASK_NAME}`);
  const db = deps.prisma ?? (defaultPrisma as unknown as SalesFetchPrisma);
  const now = deps.now ?? (() => new Date());

  const run = await db.salesFetchRun.create({
    data: { account_id: payload.account_id, year_month: payload.year_month, status: 'running' },
  });
  const runId = run.id;
  log.info({ runId, account_id: payload.account_id, year_month: payload.year_month }, 'sales.fetch start');

  // 1. セッション取得
  const account = await db.account.findUnique({
    where: { id: payload.account_id },
    select: { kdp_session_state_enc: true },
  });
  if (!account?.kdp_session_state_enc) {
    return fail(db, runId, now, 'no_session', 'KDP セッションが未設定です (初回キャプチャが必要)', log);
  }

  let sessionState: string;
  try {
    sessionState = decryptKdpCredentials(account.kdp_session_state_enc);
  } catch (err) {
    log.warn({ err, runId }, 'failed to decrypt kdp_session_state_enc');
    return fail(db, runId, now, 'unknown', 'セッションの復号に失敗しました', log);
  }

  // 2. レポート DL
  const dl = await deps.browserPort.downloadReport({ sessionState, yearMonth: payload.year_month });
  if (!dl.ok) {
    const reason = dl.reason === 'session_expired' ? 'session_expired' : dl.reason === 'download_failed' ? 'download_failed' : 'unknown';
    const msg =
      dl.reason === 'session_expired'
        ? `KDP セッション期限切れ。再ログイン(セッション再取得)が必要です: ${dl.message}`
        : dl.message;
    return fail(db, runId, now, reason, msg, log);
  }

  // 3. パース + 正規化 (対象月のみ)
  let normalized;
  try {
    const parsed = parseKdpReportWorkbook(dl.buffer);
    const fx = await getFxUsdJpy(db);
    normalized = normalizeKdpRows(parsed.rows, {
      targetMonth: payload.year_month,
      monthlySummaries: parsed.monthlySummaries,
      fxToJpy: { USD: fx },
    });
  } catch (err) {
    log.warn({ err, runId }, 'failed to parse KDP report');
    return fail(db, runId, now, 'parse_error', 'レポートの解析に失敗しました', log);
  }

  if (normalized.rows.length === 0) {
    // 当月にまだ実績が無いケース等。エラーではなく 0 件 done。
    await db.salesFetchRun.update({
      where: { id: runId },
      data: { status: 'done', records_upserted: 0, finished_at: now() },
    });
    log.info({ runId }, 'sales.fetch done (0 rows for month)');
    return { ok: true, recordsUpserted: 0, runId };
  }

  // 4. ASIN → book_id
  const asins = normalized.rows.map((r) => r.asin);
  const books = await db.book.findMany({ where: { asin: { in: asins } }, select: { id: true, asin: true } });
  const bookByAsin = new Map(books.filter((b) => b.asin).map((b) => [b.asin as string, b.id]));
  const bookIds = Array.from(bookByAsin.values());

  // 手動確定(manual_upload)は自動で上書きしない。
  const existing =
    bookIds.length > 0
      ? await db.salesRecord.findMany({ where: { book_id: { in: bookIds }, year_month: payload.year_month }, select: { book_id: true, source: true } })
      : [];
  const existingSource = new Map(existing.map((e) => [e.book_id, e.source]));

  let upserted = 0;
  let skippedProtected = 0;
  for (const r of normalized.rows) {
    const bookId = bookByAsin.get(r.asin);
    if (!bookId) continue;
    if (PROTECTED_SOURCES.has(existingSource.get(bookId) ?? '')) {
      skippedProtected++;
      continue;
    }
    try {
      await db.salesRecord.upsert({
        where: { book_id_year_month: { book_id: bookId, year_month: payload.year_month } },
        create: {
          book_id: bookId,
          year_month: payload.year_month,
          royalty_jpy: r.royalty_jpy,
          units_sold: r.units_sold,
          kenp_read: r.kenp_read,
          source: 'auto',
        },
        update: {
          royalty_jpy: r.royalty_jpy,
          units_sold: r.units_sold,
          kenp_read: r.kenp_read,
          source: 'auto',
        },
      });
      upserted++;
    } catch (err) {
      log.warn({ err, runId, asin: r.asin }, 'salesRecord.upsert failed; skipping');
    }
  }

  await db.salesFetchRun.update({
    where: { id: runId },
    data: {
      status: 'done',
      records_upserted: upserted,
      finished_at: now(),
      ...(skippedProtected > 0 ? { error_message: `手動確定 ${skippedProtected} 件は上書き回避` } : {}),
    },
  });
  log.info({ runId, recordsUpserted: upserted, skippedProtected }, 'sales.fetch done');
  return { ok: true, recordsUpserted: upserted, runId };
}

async function getFxUsdJpy(db: SalesFetchPrisma): Promise<number> {
  try {
    const row = await db.modelCatalog.findFirst({
      where: { is_current: true },
      select: { fx_rate_usd_jpy: true },
      orderBy: { fetched_at: 'desc' },
    });
    const v = row ? Number(row.fx_rate_usd_jpy) : NaN;
    return Number.isFinite(v) && v > 0 ? v : 150;
  } catch {
    return 150;
  }
}

async function fail(
  db: SalesFetchPrisma,
  runId: string,
  now: () => Date,
  reason: NonNullable<SalesFetchResult['reason']>,
  message: string,
  log: Logger,
): Promise<SalesFetchResult> {
  await db.salesFetchRun.update({
    where: { id: runId },
    data: { status: 'failed', error_message: message, finished_at: now() },
  });
  log.warn({ runId, reason, message }, 'sales.fetch failed');
  return { ok: false, recordsUpserted: 0, runId, reason };
}

// ---------------------------------------------------------------------------
// graphile-worker Task 薄ラッパ
// ---------------------------------------------------------------------------

import type { Task } from 'graphile-worker';
import { createPlaywrightBrowserPort } from './sales-fetch/playwright-browser-port.js';

export const salesFetchTask: Task = async (payload: unknown, _helpers) => {
  const parsed = SalesFetchPayload.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Invalid sales.fetch payload: ${parsed.error.message}`);
  }
  await runSalesFetch({ payload: parsed.data, browserPort: createPlaywrightBrowserPort() });
};
