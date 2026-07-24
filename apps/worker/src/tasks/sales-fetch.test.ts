import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as XLSX from 'xlsx';

import { runSalesFetch, type SalesFetchPrisma } from './sales-fetch.js';
import {
  createFixtureBrowserPort,
  createSessionExpiredBrowserPort,
} from './sales-fetch/browser-port.js';
import type { Logger } from '@a2p/contracts/logger';
import { encryptKdpCredentials } from '@a2p/crypto';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNT_ID = 'account-id-001';
const YEAR_MONTH = '2026-06';
const KNOWN_ASIN = 'B0KNOWN0AA';
const KNOWN_BOOK_ID = 'book-aaa';
const encKey = Buffer.alloc(32, 0x01);

/** 月別ロイヤリティ明細(Prior Month)形式の xlsx を生成 (KENP ロイヤリティ金額あり)。 */
function makePmrXlsx(): Buffer {
  const wb = XLSX.utils.book_new();
  const paid = [
    ['販売期間', '6月 2026'],
    ['タイトル', '著者', 'ASIN', 'マーケットプレイス', '注文数', '払い戻し数', '実質注文数', 'ロイヤリティの種類', 'コンテンツ区分', '通貨', '平均希望小売価格 (税別)', '平均販売価格 (税別)', '平均ファイルサイズ（MB）', '平均配信コスト', 'ロイヤリティ'],
    ['最強競馬予想術', '宮田海斗', KNOWN_ASIN, 'Amazon.co.jp', 1, 0, 1, '70%', '標準', 'JPY', 400, 400, 0.22, 1, 279],
  ];
  const kenp = [
    ['販売期間', '6月 2026'],
    ['タイトル', '著者', 'ASIN', 'マーケットプレイス', '既読 KENP (Kindle Edition Normalized Pages)', 'ロイヤリティ', '通貨'],
    ['最強競馬予想術', '宮田海斗', KNOWN_ASIN, 'Amazon.co.jp', 145, 54.01, 'JPY'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(paid), '電子書籍のロイヤリティ');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(kenp), '既読 KENPC');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function encSession(): string {
  return encryptKdpCredentials(JSON.stringify({ cookies: [], origins: [] }), encKey);
}

// ---------------------------------------------------------------------------
// Prisma モック
// ---------------------------------------------------------------------------

function makeMockPrisma(overrides?: {
  sessionEnc?: string | null;
  asinMap?: Record<string, string>;
  existingSource?: Record<string, string>;
}) {
  const runUpdates: Array<Parameters<SalesFetchPrisma['salesFetchRun']['update']>[0]> = [];
  const upserts: Array<Parameters<SalesFetchPrisma['salesRecord']['upsert']>[0]> = [];
  const sessionEnc = overrides?.sessionEnc !== undefined ? overrides.sessionEnc : encSession();
  const asinMap = overrides?.asinMap ?? { [KNOWN_ASIN]: KNOWN_BOOK_ID };
  const existingSource = overrides?.existingSource ?? {};
  let n = 0;

  const db: SalesFetchPrisma = {
    account: { findUnique: vi.fn().mockResolvedValue({ kdp_session_state_enc: sessionEnc }) },
    salesFetchRun: {
      create: vi.fn().mockImplementation(() => Promise.resolve({ id: `run-${++n}` })),
      update: vi.fn().mockImplementation((a) => { runUpdates.push(a); return Promise.resolve({}); }),
    },
    book: {
      findMany: vi.fn().mockImplementation(({ where }: { where: { asin: { in: string[] } } }) =>
        Promise.resolve(where.asin.in.filter((a) => asinMap[a]).map((a) => ({ id: asinMap[a], asin: a })))),
    },
    salesRecord: {
      findMany: vi.fn().mockImplementation(() =>
        Promise.resolve(Object.entries(existingSource).map(([book_id, source]) => ({ book_id, source })))),
      upsert: vi.fn().mockImplementation((a) => { upserts.push(a); return Promise.resolve({}); }),
    },
    modelCatalog: { findFirst: vi.fn().mockResolvedValue({ fx_rate_usd_jpy: 150 }) },
  };
  return { db, runUpdates, upserts };
}

const silentLogger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(),
  child: () => silentLogger,
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSalesFetch (auto-fetch Phase2)', () => {
  beforeEach(() => { process.env.KDP_CRED_KEY = encKey.toString('hex'); });

  it('セッション+xlsxで対象月を upsert(source=auto)し done を返す', async () => {
    const { db, runUpdates, upserts } = makeMockPrisma();
    const res = await runSalesFetch({
      payload: { account_id: ACCOUNT_ID, year_month: YEAR_MONTH },
      browserPort: createFixtureBrowserPort(makePmrXlsx()),
      prisma: db,
      logger: silentLogger,
      now: () => new Date('2026-07-01T00:00:00Z'),
    });
    expect(res.ok).toBe(true);
    expect(res.recordsUpserted).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.create.source).toBe('auto');
    expect(upserts[0]!.create.royalty_jpy).toBe(333); // 279 paid + 54 KENP(round)
    expect(upserts[0]!.create.kenp_read).toBe(145);
    expect(upserts[0]!.create.units_sold).toBe(1);
    expect(runUpdates.find((u) => u.data.status === 'done')).toBeTruthy();
  });

  it('セッション未設定 → reason=no_session, failed', async () => {
    const { db, runUpdates } = makeMockPrisma({ sessionEnc: null });
    const res = await runSalesFetch({
      payload: { account_id: ACCOUNT_ID, year_month: YEAR_MONTH },
      browserPort: createFixtureBrowserPort(makePmrXlsx()),
      prisma: db,
      logger: silentLogger,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no_session');
    expect(runUpdates.find((u) => u.data.status === 'failed')).toBeTruthy();
  });

  it('セッション期限切れ → reason=session_expired, failed', async () => {
    const { db, runUpdates } = makeMockPrisma();
    const res = await runSalesFetch({
      payload: { account_id: ACCOUNT_ID, year_month: YEAR_MONTH },
      browserPort: createSessionExpiredBrowserPort(),
      prisma: db,
      logger: silentLogger,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('session_expired');
    const f = runUpdates.find((u) => u.data.status === 'failed');
    expect(f).toBeTruthy();
    expect(String(f!.data.error_message)).toContain('セッション期限切れ');
  });

  it('手動確定(manual_upload)は自動で上書きしない', async () => {
    const { db, upserts, runUpdates } = makeMockPrisma({ existingSource: { [KNOWN_BOOK_ID]: 'manual_upload' } });
    const res = await runSalesFetch({
      payload: { account_id: ACCOUNT_ID, year_month: YEAR_MONTH },
      browserPort: createFixtureBrowserPort(makePmrXlsx()),
      prisma: db,
      logger: silentLogger,
    });
    expect(res.ok).toBe(true);
    expect(res.recordsUpserted).toBe(0);
    expect(upserts).toHaveLength(0);
    expect(runUpdates.find((u) => u.data.status === 'done')).toBeTruthy();
  });

  it('未突合ASINは0件でも done', async () => {
    const { db, upserts } = makeMockPrisma({ asinMap: {} });
    const res = await runSalesFetch({
      payload: { account_id: ACCOUNT_ID, year_month: YEAR_MONTH },
      browserPort: createFixtureBrowserPort(makePmrXlsx()),
      prisma: db,
      logger: silentLogger,
    });
    expect(res.ok).toBe(true);
    expect(res.recordsUpserted).toBe(0);
    expect(upserts).toHaveLength(0);
  });
});
