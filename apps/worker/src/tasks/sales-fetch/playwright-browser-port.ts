/**
 * KDP 実ブラウザ操作 (Playwright) — BrowserPort の本番実装 [F-038 / Phase 3 SP-14]。
 *
 * Amazon KDP にログインし、指定年月の売上/ロイヤリティレポートページの HTML を取得する。
 * playwright の import は **本ファイルに閉じる** (browser-port.ts は Playwright 非依存の契約のまま)。
 *
 * 2FA:
 *  - credentials.totp_secret があれば otplib で TOTP を生成して自動入力する。
 *  - totp_secret が無く 2FA チャレンジが出た場合は { ok:false, reason:'2fa_required' } を返す
 *    (呼出側 runSalesFetch が Kdp2FaCode を作り運営者コード入力待ちにする)。
 *
 * セレクタは Amazon のサインインUIに合わせた best-effort。実アカウントでの調整は
 * env (KDP_SIGNIN_URL / KDP_REPORT_URL_TEMPLATE) と本ファイルで行う。
 */
import { authenticator } from 'otplib';

import { createLogger } from '@a2p/contracts/logger';

import type {
  BrowserPort,
  FetchReportHtmlArgs,
  FetchReportHtmlResult,
} from './browser-port.js';

const log = createLogger('worker.sales-fetch.playwright');

const SIGNIN_URL = process.env.KDP_SIGNIN_URL ?? 'https://kdp.amazon.co.jp/';
/** {ym} を YYYY-MM に置換して使うレポートページ URL テンプレート。 */
const REPORT_URL_TEMPLATE =
  process.env.KDP_REPORT_URL_TEMPLATE ?? 'https://kdp.amazon.co.jp/ja_JP/reports-new';
const DEFAULT_TIMEOUT_MS = 60_000;

/** コンテナ (Railway) 上の Chromium 起動に必要な引数。 */
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

export function createPlaywrightBrowserPort(): BrowserPort {
  return { fetchReportHtml };
}

async function fetchReportHtml(args: FetchReportHtmlArgs): Promise<FetchReportHtmlResult> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // playwright は動的 import (Chromium 不在環境でモジュールロード時に落ちないように)。
  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    return { ok: false, reason: 'unknown', message: `playwright unavailable: ${errMsg(err)}` };
  }

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  try {
    const context = await browser.newContext({
      locale: 'ja-JP',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    // --- 1. サインインページへ ---
    await page.goto(SIGNIN_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // KDP トップに「サインイン」導線がある場合は踏む (既にサインインフォームなら空振り)。
    await clickIfPresent(page, 'a#signin, a[href*="/ap/signin"], #a-autoid-0-announce', 3_000);

    // --- 2. Email 入力 ---
    const emailInput = 'input[type="email"], input#ap_email';
    if (await isVisible(page, emailInput, 8_000)) {
      await page.fill(emailInput, args.credentials.email);
      await clickIfPresent(page, 'input#continue, #continue', 3_000);
    }

    // --- 3. Password 入力 ---
    const pwInput = 'input[type="password"], input#ap_password';
    if (!(await isVisible(page, pwInput, 10_000))) {
      return { ok: false, reason: 'login_failed', message: 'password field not found' };
    }
    await page.fill(pwInput, args.credentials.password);
    // 「ログイン状態を保持」があればチェック
    await checkIfPresent(page, 'input[name="rememberMe"]');
    await clickIfPresent(page, 'input#signInSubmit, #signInSubmit, #auth-signin-button', 3_000);

    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});

    // --- 4. 2FA チャレンジ判定 ---
    const otpInput = 'input#auth-mfa-otpcode, input[name="otpCode"], input#ap_otp';
    if (await isVisible(page, otpInput, 5_000)) {
      if (!args.credentials.totp_secret) {
        return { ok: false, reason: '2fa_required', message: '2FA challenge (no TOTP secret configured)' };
      }
      const code = generateTotp(args.credentials.totp_secret);
      if (!code) {
        return { ok: false, reason: '2fa_required', message: 'failed to generate TOTP code' };
      }
      await page.fill(otpInput, code);
      await checkIfPresent(page, 'input#auth-mfa-remember-device');
      await clickIfPresent(page, 'input#auth-signin-button, #auth-signin-button, input#signInSubmit', 3_000);
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
    }

    // --- 5. ログイン成否の簡易判定 ---
    // まだ password / otp フォームが残っている = 失敗。
    if (await isVisible(page, pwInput, 2_000)) {
      const errText = await textIfPresent(page, '#auth-error-message-box, .a-alert-content');
      return { ok: false, reason: 'login_failed', message: errText || 'still on sign-in page after submit' };
    }
    if (await isVisible(page, otpInput, 1_500)) {
      return { ok: false, reason: '2fa_required', message: '2FA still required after TOTP attempt' };
    }

    // --- 6. レポートページへ ---
    const reportUrl = REPORT_URL_TEMPLATE.replace('{ym}', args.yearMonth);
    await page.goto(reportUrl, { waitUntil: 'networkidle', timeout: timeoutMs }).catch(async () => {
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
    });

    // レポートテーブルの描画を少し待つ (SPA レンダリング)。
    await page.waitForTimeout(4_000);

    const html = await page.content();
    log.info(
      { yearMonth: args.yearMonth, url: page.url(), htmlBytes: html.length },
      'fetched KDP report page html',
    );
    return { ok: true, html, source: 'kdp_report_page' };
  } catch (err) {
    const msg = errMsg(err);
    const reason = /timeout/i.test(msg) ? 'timeout' : 'unknown';
    log.warn({ err: msg }, 'playwright fetchReportHtml failed');
    return { ok: false, reason, message: msg };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function generateTotp(secret: string): string | null {
  try {
    return authenticator.generate(secret.replace(/\s+/g, ''));
  } catch {
    return null;
  }
}

async function isVisible(
  page: import('playwright').Page,
  selector: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function clickIfPresent(
  page: import('playwright').Page,
  selector: string,
  timeoutMs: number,
): Promise<void> {
  try {
    const el = await page.waitForSelector(selector, { state: 'visible', timeout: timeoutMs });
    if (el) await el.click({ timeout: timeoutMs }).catch(() => {});
  } catch {
    /* not present — skip */
  }
}

async function checkIfPresent(
  page: import('playwright').Page,
  selector: string,
): Promise<void> {
  try {
    const el = await page.$(selector);
    if (el) await el.check({ timeout: 2_000 }).catch(() => {});
  } catch {
    /* skip */
  }
}

async function textIfPresent(
  page: import('playwright').Page,
  selector: string,
): Promise<string | null> {
  try {
    const el = await page.$(selector);
    if (!el) return null;
    return ((await el.textContent()) ?? '').trim() || null;
  } catch {
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
