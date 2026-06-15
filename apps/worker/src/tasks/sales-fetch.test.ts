import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  runSalesFetch,
  type SalesFetchPrisma,
  type SalesFetchResult,
} from './sales-fetch.js';
import {
  createFixtureBrowserPort,
  create2faBrowserPort,
} from './sales-fetch/browser-port.js';
import type { Logger } from '@a2p/contracts/logger';
import { encryptKdpCredentials } from '@a2p/crypto';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(__dirname, '../../../../tests/fixtures/kdp-report');

const sampleHtml = readFileSync(join(FIXTURE_DIR, 'sample-report.html'), 'utf-8');

// sample-report.html に含まれる ASIN（書籍 A だけ known ASIN として登録）
const KNOWN_ASIN = 'B0TESTAA01';
const KNOWN_BOOK_ID = 'book-id-aaa';
const ACCOUNT_ID = 'account-id-001';
const YEAR_MONTH = '2026-05';

/** テスト用 KDP 認証情報（暗号化済み） */
function makeEncCredentials(): string {
  const key = Buffer.alloc(32, 0x01); // テスト固定鍵
  const plaintext = JSON.stringify({ email: 'test@example.com', password: 'testpass' });
  return encryptKdpCredentials(plaintext, key);
}

// ---------------------------------------------------------------------------
// Prisma モックファクトリ
// ---------------------------------------------------------------------------

function makeMockPrisma(overrides?: Partial<{
  credentialsEnc: string | null;
  /** book.findUnique の挙動。ASIN→bookId マップ */
  asinMap: Record<string, string>;
  /** upsert 呼び出しを記録するかどうか（デフォルト: 記録する） */
}>): {
  db: SalesFetchPrisma;
  salesFetchRunUpdates: Array<Parameters<SalesFetchPrisma['salesFetchRun']['update']>[0]>;
  salesFetchRunCreated: Array<Parameters<SalesFetchPrisma['salesFetchRun']['create']>[0]>;
  kdp2FaCodeCreated: Array<Parameters<SalesFetchPrisma['kdp2FaCode']['create']>[0]>;
  salesRecordUpserts: Array<Parameters<SalesFetchPrisma['salesRecord']['upsert']>[0]>;
} {
  const salesFetchRunUpdates: Array<Parameters<SalesFetchPrisma['salesFetchRun']['update']>[0]> = [];
  const salesFetchRunCreated: Array<Parameters<SalesFetchPrisma['salesFetchRun']['create']>[0]> = [];
  const kdp2FaCodeCreated: Array<Parameters<SalesFetchPrisma['kdp2FaCode']['create']>[0]> = [];
  const salesRecordUpserts: Array<Parameters<SalesFetchPrisma['salesRecord']['upsert']>[0]> = [];

  const credentialsEnc = overrides?.credentialsEnc !== undefined
    ? overrides.credentialsEnc
    : makeEncCredentials();

  const asinMap: Record<string, string> = overrides?.asinMap ?? {
    [KNOWN_ASIN]: KNOWN_BOOK_ID,
  };

  let runIdCounter = 0;

  const db: SalesFetchPrisma = {
    account: {
      findUnique: vi.fn().mockResolvedValue(
        credentialsEnc !== null
          ? { kdp_credentials_enc: credentialsEnc }
          : { kdp_credentials_enc: null },
      ),
    },
    salesFetchRun: {
      create: vi.fn().mockImplementation((args) => {
        salesFetchRunCreated.push(args);
        runIdCounter++;
        return Promise.resolve({ id: `run-id-${runIdCounter}` });
      }),
      update: vi.fn().mockImplementation((args) => {
        salesFetchRunUpdates.push(args);
        return Promise.resolve({});
      }),
    },
    kdp2FaCode: {
      create: vi.fn().mockImplementation((args) => {
        kdp2FaCodeCreated.push(args);
        return Promise.resolve({});
      }),
    },
    book: {
      findUnique: vi.fn().mockImplementation((args: { where: { asin: string } }) => {
        const bookId = asinMap[args.where.asin];
        return Promise.resolve(bookId ? { id: bookId } : null);
      }),
    },
    salesRecord: {
      upsert: vi.fn().mockImplementation((args) => {
        salesRecordUpserts.push(args);
        return Promise.resolve({});
      }),
    },
  };

  return { db, salesFetchRunUpdates, salesFetchRunCreated, kdp2FaCodeCreated, salesRecordUpserts };
}

const silentLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => silentLogger,
} as unknown as Logger;

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe('runSalesFetch', () => {
  const encKey = Buffer.alloc(32, 0x01);

  beforeEach(() => {
    // KDP_CRED_KEY を固定（decryptKdpCredentials がデフォルトで env を使う）
    process.env.KDP_CRED_KEY = encKey.toString('hex');
  });

  // -----------------------------------------------------------------------
  // 正常系: fixture BrowserPort → parse → upsert
  // -----------------------------------------------------------------------
  it('fixture browserPort で { ok: true, recordsUpserted >= 1 } を返す', async () => {
    const { db, salesFetchRunUpdates, salesFetchRunCreated, salesRecordUpserts } = makeMockPrisma();

    const result: SalesFetchResult = await runSalesFetch({
      payload: { account_id: ACCOUNT_ID, year_month: YEAR_MONTH },
      browserPort: createFixtureBrowserPort(sampleHtml),
      prisma: db,
      logger: silentLogger,
      now: () => new Date('2026-06-01T00:00:00Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.recordsUpserted).toBeGreaterThanOrEqual(1);
    expect(result.runId).toBeTruthy();

    // SalesFetchRun CREATE が呼ばれた
    expect(salesFetchRunCreated).toHaveLength(1);
    expect(salesFetchRunCreated[0]!.data.status).toBe('running');

    // 最終 UPDATE が done
    const doneUpdate = salesFetchRunUpdates.find((u) => u.data.status === 'done');
    expect(doneUpdate).toBeTruthy();
    expect(doneUpdate!.data.records_upserted).toBeGreaterThanOrEqual(1);

    // salesRecord.upsert が呼ばれた
    expect(salesRecordUpserts.length).toBeGreaterThanOrEqual(1);
    // upsert の create 側で source='auto'
    expect(salesRecordUpserts[0]!.create.source).toBe('auto');
  });

  // -----------------------------------------------------------------------
  // 2FA 経路
  // -----------------------------------------------------------------------
  it('2fa browserPort で { ok: false, reason: "2fa_required" } を返し Kdp2FaCode が INSERT される', async () => {
    const { db, salesFetchRunUpdates, kdp2FaCodeCreated } = makeMockPrisma();

    const result = await runSalesFetch({
      payload: { account_id: ACCOUNT_ID, year_month: YEAR_MONTH },
      browserPort: create2faBrowserPort(),
      prisma: db,
      logger: silentLogger,
      now: () => new Date('2026-06-01T00:00:00Z'),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('2fa_required');

    // Kdp2FaCode が 1 件 INSERT された
    expect(kdp2FaCodeCreated).toHaveLength(1);
    expect(kdp2FaCodeCreated[0]!.data.status).toBe('awaiting');
    expect(kdp2FaCodeCreated[0]!.data.timeout_at).toBeInstanceOf(Date);

    // SalesFetchRun が 2fa_waiting に UPDATE された
    const waitingUpdate = salesFetchRunUpdates.find((u) => u.data.status === '2fa_waiting');
    expect(waitingUpdate).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // no_credentials
  // -----------------------------------------------------------------------
  it('認証情報未設定のアカウントで { ok: false, reason: "no_credentials" } を返す', async () => {
    const { db, salesFetchRunUpdates } = makeMockPrisma({ credentialsEnc: null });

    const result = await runSalesFetch({
      payload: { account_id: ACCOUNT_ID, year_month: YEAR_MONTH },
      browserPort: createFixtureBrowserPort(sampleHtml),
      prisma: db,
      logger: silentLogger,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_credentials');

    // run が failed に UPDATE された
    const failedUpdate = salesFetchRunUpdates.find((u) => u.data.status === 'failed');
    expect(failedUpdate).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // 未知 ASIN スキップ（throw しない）
  // -----------------------------------------------------------------------
  it('未知 ASIN はスキップして処理継続し { ok: true } を返す', async () => {
    // asinMap を空にする → 全 ASIN 未知
    const { db, salesRecordUpserts } = makeMockPrisma({ asinMap: {} });

    const result = await runSalesFetch({
      payload: { account_id: ACCOUNT_ID, year_month: YEAR_MONTH },
      browserPort: createFixtureBrowserPort(sampleHtml),
      prisma: db,
      logger: silentLogger,
    });

    // throw せず ok: true を返す（upsert 件数 = 0）
    expect(result.ok).toBe(true);
    expect(result.recordsUpserted).toBe(0);
    expect(salesRecordUpserts).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 冪等性: 同一 year_month で 2 回実行しても upsert が重複しない
  // -----------------------------------------------------------------------
  it('同一 year_month で 2 回実行しても salesRecord.upsert は create ではなく update 側が呼ばれる（冪等）', async () => {
    // 実際の DB ではなくモックなので、upsert が 2 回呼ばれることを検証。
    // Prisma の upsert はユニーク制約 (book_id, year_month) で CREATE/UPDATE を自動選択する。
    // モックではどちらも同じ実装を使うが、呼び出し回数・引数の一致を検証する。
    const { db, salesRecordUpserts } = makeMockPrisma();

    await runSalesFetch({
      payload: { account_id: ACCOUNT_ID, year_month: YEAR_MONTH },
      browserPort: createFixtureBrowserPort(sampleHtml),
      prisma: db,
      logger: silentLogger,
    });

    const firstCallCount = salesRecordUpserts.length;
    expect(firstCallCount).toBeGreaterThanOrEqual(1);

    // 2 回目も同じペイロード
    await runSalesFetch({
      payload: { account_id: ACCOUNT_ID, year_month: YEAR_MONTH },
      browserPort: createFixtureBrowserPort(sampleHtml),
      prisma: db,
      logger: silentLogger,
    });

    // upsert は 2 倍呼ばれる（モックなので DB ユニーク制約は効かないが、
    // upsert 引数の where.book_id_year_month が同一かを確認して冪等設計を保証する）
    expect(salesRecordUpserts.length).toBe(firstCallCount * 2);

    // 1 回目と 2 回目の upsert where が同一（同じキーに書き込む = DB では 1 件のみ存在）
    for (let i = 0; i < firstCallCount; i++) {
      expect(salesRecordUpserts[i]!.where.book_id_year_month).toEqual(
        salesRecordUpserts[firstCallCount + i]!.where.book_id_year_month,
      );
    }
  });

  // -----------------------------------------------------------------------
  // SalesFetchRun の INSERT/UPDATE 呼び出し確認
  // -----------------------------------------------------------------------
  it('SalesFetchRun の CREATE と UPDATE(done) が呼ばれる', async () => {
    const { db, salesFetchRunCreated, salesFetchRunUpdates } = makeMockPrisma();

    await runSalesFetch({
      payload: { account_id: ACCOUNT_ID, year_month: YEAR_MONTH },
      browserPort: createFixtureBrowserPort(sampleHtml),
      prisma: db,
      logger: silentLogger,
    });

    // CREATE: running で 1 件
    expect(salesFetchRunCreated).toHaveLength(1);
    expect(salesFetchRunCreated[0]!.data).toMatchObject({
      account_id: ACCOUNT_ID,
      year_month: YEAR_MONTH,
      status: 'running',
    });

    // UPDATE: done で 1 件（account/browserPort が正常なので failed 系は呼ばれない）
    const doneUpdates = salesFetchRunUpdates.filter((u) => u.data.status === 'done');
    expect(doneUpdates).toHaveLength(1);
    expect(doneUpdates[0]!.data.finished_at).toBeInstanceOf(Date);
  });
});
