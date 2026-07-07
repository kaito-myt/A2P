import { z } from 'zod';

import { createLogger, type Logger } from '@a2p/contracts/logger';
import { decryptKdpCredentials } from '@a2p/crypto';
import { prisma as defaultPrisma, Prisma } from '@a2p/db';

import {
  parseKdpSalesHtml,
} from './sales-fetch/parser.js';
import type { BrowserPort } from './sales-fetch/browser-port.js';

/**
 * `sales.fetch` ワーカタスク (F-038, SP-12 T-12-04)
 *
 * 純ロジック関数 `runSalesFetch(deps)` + graphile-worker 薄ラッパ。
 * `BrowserPort` を DI して実ブラウザなしで単体テスト可能。
 *
 * HARD RULE: playwright の import を書いてはならない。
 * Playwright 依存は Phase 3 (SP-14) のみ。
 */

export const SALES_FETCH_TASK_NAME = 'sales.fetch';

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
      select: { kdp_credentials_enc: true };
    }): Promise<{ kdp_credentials_enc: string | null } | null>;
  };
  salesFetchRun: {
    create(args: {
      data: {
        account_id: string;
        year_month: string;
        status: string;
      };
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
  kdp2FaCode: {
    create(args: {
      data: {
        job_id: string;
        status: string;
        timeout_at: Date;
      };
    }): Promise<unknown>;
  };
  book: {
    findUnique(args: {
      where: { asin: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  salesRecord: {
    upsert(args: {
      where: { book_id_year_month: { book_id: string; year_month: string } };
      create: {
        book_id: string;
        year_month: string;
        royalty_jpy: number;
        review_count: number;
        avg_stars: Prisma.Decimal | null;
        bsr: number | null;
        source: string;
      };
      update: {
        royalty_jpy: number;
        review_count: number;
        avg_stars: Prisma.Decimal | null;
        bsr: number | null;
        source: string;
      };
    }): Promise<unknown>;
  };
}

export interface SalesFetchDeps {
  payload: SalesFetchPayload;
  /** ブラウザポート（テストではダミーを注入） */
  browserPort: BrowserPort;
  /** Prisma クライアント（テストではモックを注入） */
  prisma?: SalesFetchPrisma;
  /** ロガー差し替え */
  logger?: Logger;
  /** 「今」を固定（テスト用） */
  now?: () => Date;
}

export interface SalesFetchResult {
  ok: boolean;
  recordsUpserted: number;
  runId: string;
  reason?: '2fa_required' | 'login_failed' | 'no_credentials' | 'parse_error' | 'unknown';
}

// ---------------------------------------------------------------------------
// 純ロジック関数
// ---------------------------------------------------------------------------

export async function runSalesFetch(deps: SalesFetchDeps): Promise<SalesFetchResult> {
  const { payload } = deps;
  const log = deps.logger ?? createLogger(`worker.${SALES_FETCH_TASK_NAME}`);
  const db = deps.prisma ?? (defaultPrisma as unknown as SalesFetchPrisma);
  const now = deps.now ?? (() => new Date());

  // 1. SalesFetchRun INSERT (status=running)
  const run = await db.salesFetchRun.create({
    data: {
      account_id: payload.account_id,
      year_month: payload.year_month,
      status: 'running',
    },
  });
  const runId = run.id;

  log.info({ runId, account_id: payload.account_id, year_month: payload.year_month }, 'sales.fetch start');

  // 2. accounts.kdp_credentials_enc を取得
  const account = await db.account.findUnique({
    where: { id: payload.account_id },
    select: { kdp_credentials_enc: true },
  });

  if (!account?.kdp_credentials_enc) {
    log.warn({ runId, account_id: payload.account_id }, 'no kdp_credentials_enc; aborting');
    await db.salesFetchRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        error_message: 'KDP 認証情報が未設定です',
        finished_at: now(),
      },
    });
    return { ok: false, recordsUpserted: 0, runId, reason: 'no_credentials' };
  }

  // 3. decryptKdpCredentials で復号
  let credentialsJson: string;
  try {
    credentialsJson = decryptKdpCredentials(account.kdp_credentials_enc);
  } catch (err) {
    log.warn({ err, runId }, 'failed to decrypt kdp_credentials_enc');
    await db.salesFetchRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        error_message: '認証情報の復号に失敗しました',
        finished_at: now(),
      },
    });
    return { ok: false, recordsUpserted: 0, runId, reason: 'unknown' };
  }

  let credentials: { email: string; password: string; totp_secret?: string };
  try {
    credentials = JSON.parse(credentialsJson) as { email: string; password: string; totp_secret?: string };
  } catch (err) {
    log.warn({ err, runId }, 'kdp_credentials_enc payload is not valid JSON');
    await db.salesFetchRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        error_message: '認証情報の形式が不正です',
        finished_at: now(),
      },
    });
    return { ok: false, recordsUpserted: 0, runId, reason: 'unknown' };
  }

  // 4. browserPort.fetchReportHtml を呼ぶ
  const fetchResult = await deps.browserPort.fetchReportHtml({
    credentials: {
      email: credentials.email,
      password: credentials.password,
      totp_secret: credentials.totp_secret,
    },
    yearMonth: payload.year_month,
  });

  if (!fetchResult.ok) {
    if (fetchResult.reason === '2fa_required') {
      // 4a. Kdp2FaCode INSERT (status=awaiting) + run=2fa_waiting
      const timeoutAt = new Date(now().getTime() + 10 * 60 * 1000); // +10 分
      await db.kdp2FaCode.create({
        data: {
          job_id: runId,
          status: 'awaiting',
          timeout_at: timeoutAt,
        },
      });
      await db.salesFetchRun.update({
        where: { id: runId },
        data: {
          status: '2fa_waiting',
          // finished_at は 2FA 完了後に更新 (Phase 3 実装)
        },
      });
      log.info({ runId }, '2FA required; run set to 2fa_waiting');
      return { ok: false, recordsUpserted: 0, runId, reason: '2fa_required' };
    }

    // その他の失敗
    const reason = fetchResult.reason === 'login_failed' ? 'login_failed' : 'unknown';
    await db.salesFetchRun.update({
      where: { id: runId },
      data: {
        status: 'failed',
        error_message: fetchResult.message,
        finished_at: now(),
      },
    });
    log.warn({ runId, reason: fetchResult.reason, message: fetchResult.message }, 'browser fetch failed');
    return { ok: false, recordsUpserted: 0, runId, reason };
  }

  // 5. parseKdpSalesHtml でパース
  const rows = parseKdpSalesHtml(fetchResult.html, payload.year_month);
  log.info({ runId, rowCount: rows.length }, 'parsed sales rows');

  // 6. 各 KdpSalesRow を sales_records upsert
  // NOTE: KdpSalesRow に units_sold は存在するが SalesRecord には units_sold 列がない。
  //       永続化対象は royalty_jpy / review_count / avg_stars / bsr のみ。
  let upserted = 0;
  for (const row of rows) {
    // ASIN → book_id 変換
    const bookRow = await db.book.findUnique({
      where: { asin: row.asin },
      select: { id: true },
    });

    if (!bookRow) {
      log.warn({ runId, asin: row.asin }, 'unknown ASIN; skipping row (no throw)');
      continue;
    }

    try {
      await db.salesRecord.upsert({
        where: {
          book_id_year_month: {
            book_id: bookRow.id,
            year_month: row.year_month,
          },
        },
        create: {
          book_id: bookRow.id,
          year_month: row.year_month,
          royalty_jpy: row.royalty_jpy,
          review_count: row.review_count,
          avg_stars: row.avg_stars !== null ? new Prisma.Decimal(row.avg_stars) : null,
          bsr: row.bsr,
          source: 'auto',
        },
        update: {
          royalty_jpy: row.royalty_jpy,
          review_count: row.review_count,
          avg_stars: row.avg_stars !== null ? new Prisma.Decimal(row.avg_stars) : null,
          bsr: row.bsr,
          source: 'auto',
        },
      });
      upserted++;
    } catch (err) {
      log.warn({ err, runId, asin: row.asin }, 'salesRecord.upsert failed; skipping');
    }
  }

  // 7. SalesFetchRun done
  await db.salesFetchRun.update({
    where: { id: runId },
    data: {
      status: 'done',
      records_upserted: upserted,
      finished_at: now(),
    },
  });

  log.info({ runId, recordsUpserted: upserted }, 'sales.fetch done');

  // 8. 返却
  return { ok: true, recordsUpserted: upserted, runId };
}

// ---------------------------------------------------------------------------
// graphile-worker Task 薄ラッパ
// ---------------------------------------------------------------------------

import type { Task } from 'graphile-worker';
import { createFixtureBrowserPort } from './sales-fetch/browser-port.js';
import { createPlaywrightBrowserPort } from './sales-fetch/playwright-browser-port.js';

export const salesFetchTask: Task = async (payload: unknown, _helpers) => {
  const parsed = SalesFetchPayload.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Invalid sales.fetch payload: ${parsed.error.message}`);
  }

  // Phase 3: 実ブラウザ (Playwright + Chromium) で KDP にログインしレポートを取得する。
  // env `SALES_FETCH_BROWSER=fixture` の時のみ空 HTML の stub にフォールバック (検証用)。
  const browserPort =
    process.env.SALES_FETCH_BROWSER === 'fixture'
      ? createFixtureBrowserPort('')
      : createPlaywrightBrowserPort();

  await runSalesFetch({ payload: parsed.data, browserPort });
};
