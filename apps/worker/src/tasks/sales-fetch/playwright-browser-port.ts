/**
 * KDP レポート取得 (Playwright) — BrowserPort の本番実装 [F-038 / Phase2 自動取得]。
 *
 * 保存済みセッション(storageState)で Playwright コンテキストを作り、月別ロイヤリティ
 * (PMR)レポートの DL エンドポイントを **2 段 GET** で叩いて xlsx を取得する。
 * DOM 操作は行わない (実 KDP で検証済みの安定経路)。playwright の import は本ファイルに閉じる。
 *
 * セッション切れ判定: DL エンドポイントが JSON を返さない / サインインへ誘導 /
 * 4xx を返す場合は reason='session_expired' を返し、呼出側が運営者へ再取得を促す。
 */
import { createLogger } from '@a2p/contracts/logger';

import type {
  BrowserPort,
  DownloadReportArgs,
  DownloadReportResult,
} from './browser-port.js';

const log = createLogger('worker.sales-fetch.playwright');

const DEFAULT_TIMEOUT_MS = 60_000;
const REPORTS_HOST = process.env.KDP_REPORTS_HOST ?? 'https://kdpreports.amazon.co.jp';
/** {ym} を YYYY-MM に置換して使う PMR ダウンロードエンドポイント。 */
const PMR_DOWNLOAD_PATH = '/download/report/pmr/ja_JP/pmrReport.xslx?selectedMonth={ym}&reportType=KDP_PMR';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/** コンテナ (Railway) 上の Chromium 起動引数。 */
const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

export function createPlaywrightBrowserPort(): BrowserPort {
  return { downloadReport };
}

async function downloadReport(args: DownloadReportArgs): Promise<DownloadReportResult> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let storageState: unknown;
  try {
    storageState = JSON.parse(args.sessionState);
  } catch {
    return { ok: false, reason: 'session_expired', message: 'stored session is not valid JSON' };
  }

  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    return { ok: false, reason: 'unknown', message: `playwright unavailable: ${errMsg(err)}` };
  }

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    const context = await browser.newContext({
      // storageState 型は Playwright の StorageState (復号済み JSON をそのまま渡す)。
      // 型注釈は type-only import なので "playwright を import しない" ルールに抵触しない。
      storageState: storageState as Awaited<
        ReturnType<import('playwright').BrowserContext['storageState']>
      >,
      locale: 'ja-JP',
      userAgent: UA,
      acceptDownloads: true,
    });

    const endpoint = REPORTS_HOST + PMR_DOWNLOAD_PATH.replace('{ym}', args.yearMonth);

    // --- 1 段目: DL エンドポイント → S3 署名 URL を含む JSON ---
    // report 生成が間に合わない (available:false → S3 404) 場合に備え数回リトライ。
    let s3Url: string | null = null;
    let lastMsg = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await context.request.get(endpoint, { timeout: timeoutMs });
      const status = res.status();
      const ct = (res.headers()['content-type'] ?? '').toLowerCase();
      const finalUrl = res.url();

      // サインイン誘導 / HTML / 401,403 → セッション切れ。
      if (status === 401 || status === 403 || /\/ap\/signin|\/signin/i.test(finalUrl)) {
        return {
          ok: false,
          reason: 'session_expired',
          message: `download endpoint returned auth challenge (status=${status}, url=${finalUrl})`,
        };
      }
      if (!ct.includes('json')) {
        const body = (await res.text().catch(() => '')).slice(0, 200);
        if (/sign\s*-?in|ログイン|パスワード|ap_email/i.test(body)) {
          return { ok: false, reason: 'session_expired', message: 'download endpoint returned a sign-in page' };
        }
        lastMsg = `unexpected content-type=${ct} status=${status}`;
        await sleep(4000);
        continue;
      }

      let json: unknown;
      try {
        json = JSON.parse(await res.text());
      } catch {
        lastMsg = 'download endpoint JSON parse failed';
        await sleep(4000);
        continue;
      }
      const url = extractUrl(json);
      if (!url) {
        lastMsg = `no url field in response (keys=${json && typeof json === 'object' ? Object.keys(json).join(',') : 'n/a'})`;
        await sleep(4000);
        continue;
      }

      // --- 2 段目: S3 署名 URL → xlsx バイナリ ---
      const xlsxRes = await context.request.get(url, { timeout: timeoutMs });
      if (xlsxRes.status() === 200) {
        const buf = Buffer.from(await xlsxRes.body());
        if (buf.length > 500) {
          const filename = filenameFromUrl(url);
          log.info({ yearMonth: args.yearMonth, bytes: buf.length, filename }, 'downloaded KDP PMR report');
          return { ok: true, buffer: buf, filename };
        }
        lastMsg = `xlsx too small (${buf.length} bytes)`;
      } else {
        lastMsg = `s3 fetch status=${xlsxRes.status()}`;
      }
      s3Url = url;
      await sleep(5000); // report 生成待ち
    }

    return { ok: false, reason: 'download_failed', message: lastMsg || (s3Url ? 'report not ready' : 'download failed') };
  } catch (err) {
    const msg = errMsg(err);
    const reason = /timeout/i.test(msg) ? 'timeout' : 'unknown';
    log.warn({ err: msg }, 'playwright downloadReport failed');
    return { ok: false, reason, message: msg };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function extractUrl(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const candidates = [o.url, o.downloadUrl, o.presignedUrl, o.location, o.s3Url, o.reportUrl];
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//.test(c)) return c;
  }
  const data = o.data as Record<string, unknown> | undefined;
  if (data) {
    for (const c of [data.url, data.downloadUrl]) {
      if (typeof c === 'string' && /^https?:\/\//.test(c)) return c;
    }
  }
  return null;
}

function filenameFromUrl(url: string): string | null {
  try {
    const p = new URL(url).pathname;
    const base = p.split('/').pop() ?? '';
    return base || null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
