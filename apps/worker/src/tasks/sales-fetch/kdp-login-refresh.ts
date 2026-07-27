/**
 * KDP 自動再ログイン (ヘッドレス DOM 操作) [F-038 sales.fetch セッション切れ時の自動回復]。
 *
 * `sales.fetch` のレポート DL が `session_expired` を返した際に、保存済み storageState
 * (device-trust cookie を含みうる) を引き継いだうえで Amazon/KDP にヘッドレスで
 * 再ログインし、新しい storageState を返す。OTP は LINE 双方向認証リレー
 * (`lib/line-auth-relay.ts`) で運営者に中継する (`scripts/kdp-publish.mjs` の
 * `ensureLoggedIn`/`relayOtpViaLine` と同じ考え方を worker から使えるようにしたもの)。
 *
 * HARD RULE: playwright の import はこのファイル (と playwright-browser-port.ts) に閉じる。
 */
import { createLogger } from '@a2p/contracts/logger';

import { requestOtpViaLine, pushLine, type LineAuthRelayPrisma } from '../lib/line-auth-relay.js';
import { UA, LAUNCH_ARGS } from './playwright-browser-port.js';

const log = createLogger('worker.sales-fetch.kdp-login-refresh');

const BOOKSHELF_URL = 'https://kdp.amazon.co.jp/ja_JP/bookshelf';
const EMAIL_SELECTOR = '#ap_email, input[type="email"][name="email"]';
const CONTINUE_SELECTOR = '#continue, input#continue';
const PASSWORD_SELECTOR = '#ap_password, input[type="password"][name="password"]';
const REMEMBER_ME_SELECTOR = '#rememberMe';
const SIGNIN_SUBMIT_SELECTOR = '#signInSubmit, input#signInSubmit';
const OTP_SELECTOR = '#auth-mfa-otpcode, input[name="otpCode"], #cvf-input-code, input[name="code"]';
const REMEMBER_DEVICE_SELECTOR = '#auth-mfa-remember-device';
const OTP_SUBMIT_SELECTOR = '#auth-signin-button, input[type="submit"]';

const MAX_ITERS = 40;
const ITER_WAIT_MS = 5000;
const MAX_OTP_ATTEMPTS = 3;

export interface KdpLoginRefreshDeps {
  prisma: LineAuthRelayPrisma;
  /** 直前まで使っていた storageState (device-trust cookie 維持のため引き継ぐ)。 */
  oldStorageState?: string;
}

export type KdpLoginRefreshResult =
  | { ok: true; storageState: string }
  | {
      ok: false;
      reason: 'no_creds' | 'captcha' | 'otp_timeout' | 'login_failed' | 'unknown';
      message: string;
    };

/**
 * ログインページ HTML から CAPTCHA 提示を検知する (純関数・テスト容易)。
 * ヘッドレス環境 (データセンター IP) は CAPTCHA を突破できないため、検知時は諦めて
 * 呼び出し側 (sales.fetch) が従来通り手動キャプチャへフォールバックする。
 */
export function looksLikeCaptcha(html: string): boolean {
  return (
    /captcha/i.test(html) ||
    html.includes('cvf_captcha_input') ||
    /入力してください.*文字/.test(html) ||
    /characters you see/i.test(html)
  );
}

/** URL とログイン系フォームの有無からログイン完了を判定する (純関数・テスト容易)。 */
export function isLoggedIn(url: string, hasAuthField: boolean): boolean {
  return url.includes('/bookshelf') && !/signin/i.test(url) && !hasAuthField;
}

/** `handleOtpRetryLoop` が要求する最小限のページ操作 I/F (実体は Playwright `Page`)。 */
export interface OtpCapablePage {
  $(selector: string): Promise<{ fill(value: string): Promise<void>; isVisible(): Promise<boolean> } | null>;
  check(selector: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
}

export interface OtpRetryDeps {
  requestOtp: (prompt: string) => Promise<string | null>;
  notifyFailure: (text: string) => Promise<boolean>;
  maxAttempts?: number;
}

export type OtpRetryResult =
  | { ok: true }
  | { ok: false; reason: 'otp_timeout' | 'login_failed'; message: string };

/**
 * OTP 入力欄が出た状態から: LINE で新コード取得 → 入力/送信 → 入力欄が消えたか確認。
 * まだ入力欄が残っている(=コード不正/期限切れ)場合は運営者に通知して取り直す
 * (最大 `maxAttempts` 回、既定 3)。`scripts/kdp-publish.mjs` の `relayOtpViaLine` は
 * 単発だが、worker はサーバー完結を優先し再送まで面倒を見る。
 */
export async function handleOtpRetryLoop(
  page: OtpCapablePage,
  deps: OtpRetryDeps,
): Promise<OtpRetryResult> {
  const maxAttempts = deps.maxAttempts ?? MAX_OTP_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await page.check(REMEMBER_DEVICE_SELECTOR).catch(() => {});
    const prompt =
      attempt === 1
        ? 'KDP売上取得のためのログイン認証です。'
        : 'KDP売上取得のためのログイン認証です(コード再入力)。';
    const code = await deps.requestOtp(prompt);
    if (!code) {
      return { ok: false, reason: 'otp_timeout', message: 'OTP relay timed out' };
    }

    const otpEl = await page.$(OTP_SELECTOR).catch(() => null);
    if (otpEl) await otpEl.fill(code).catch(() => {});
    await page.click(OTP_SUBMIT_SELECTOR).catch(() => {});
    await page.waitForTimeout(4000);

    const stillEl = await page.$(OTP_SELECTOR).catch(() => null);
    const stillVisible = stillEl ? await stillEl.isVisible().catch(() => false) : false;
    if (!stillVisible) return { ok: true };

    log.warn({ attempt, maxAttempts }, 'OTP rejected (code invalid or expired) — retrying');
    if (attempt < maxAttempts) {
      await deps.notifyFailure(
        '❌ A2P: 認証コードが正しくないか期限切れでした。認証アプリの新しい6桁コードを送ってください。',
      );
    }
  }
  return { ok: false, reason: 'login_failed', message: `OTP rejected ${maxAttempts} times` };
}

/**
 * Amazon/KDP へヘッドレスで再ログインし、新しい storageState を返す。
 * `AMAZON_EMAIL`/`AMAZON_PASSWORD` env が無ければ即座に `no_creds` を返す。
 */
export async function refreshKdpSession(deps: KdpLoginRefreshDeps): Promise<KdpLoginRefreshResult> {
  const email = process.env.AMAZON_EMAIL;
  const password = process.env.AMAZON_PASSWORD;
  if (!email || !password) {
    return { ok: false, reason: 'no_creds', message: 'AMAZON_EMAIL/AMAZON_PASSWORD が未設定です' };
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
      storageState: deps.oldStorageState
        ? (JSON.parse(deps.oldStorageState) as Awaited<
            ReturnType<import('playwright').BrowserContext['storageState']>
          >)
        : undefined,
      locale: 'ja-JP',
      userAgent: UA,
      acceptDownloads: false,
    });
    const page = await context.newPage();
    await page.goto(BOOKSHELF_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3000);

    for (let iter = 0; iter < MAX_ITERS; iter++) {
      const html = await page.content().catch(() => '');
      if (looksLikeCaptcha(html)) {
        return { ok: false, reason: 'captcha', message: 'CAPTCHA detected — cannot solve headlessly' };
      }

      const emailEl = await page.$(EMAIL_SELECTOR).catch(() => null);
      const emailVisible = emailEl ? await emailEl.isVisible().catch(() => false) : false;
      const passEl = await page.$(PASSWORD_SELECTOR).catch(() => null);
      const passVisible = passEl ? await passEl.isVisible().catch(() => false) : false;
      const otpEl = await page.$(OTP_SELECTOR).catch(() => null);
      const otpVisible = otpEl ? await otpEl.isVisible().catch(() => false) : false;
      const hasAuthField = emailVisible || passVisible || otpVisible;

      if (isLoggedIn(page.url(), hasAuthField)) {
        const storageState = JSON.stringify(await context.storageState());
        log.info('KDP re-login succeeded');
        return { ok: true, storageState };
      }

      if (emailVisible && emailEl) {
        await emailEl.fill(email).catch(() => {});
        await page.click(CONTINUE_SELECTOR).catch(() => {});
        await page.waitForTimeout(2500);
        continue;
      }

      if (passVisible && passEl) {
        await passEl.fill(password).catch(() => {});
        await page.check(REMEMBER_ME_SELECTOR).catch(() => {});
        await page.click(SIGNIN_SUBMIT_SELECTOR).catch(() => {});
        await page.waitForTimeout(3000);
        continue;
      }

      if (otpVisible) {
        const otpResult = await handleOtpRetryLoop(page, {
          requestOtp: (prompt) =>
            requestOtpViaLine(deps.prisma, { purpose: 'kdp_sales_relogin', prompt }),
          notifyFailure: (text) => pushLine(text),
        });
        if (!otpResult.ok) return otpResult;
        continue;
      }

      await page.waitForTimeout(ITER_WAIT_MS);
    }

    return {
      ok: false,
      reason: 'login_failed',
      message: `login did not complete after ${MAX_ITERS} iterations (last url=${page.url()})`,
    };
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'refreshKdpSession failed');
    return { ok: false, reason: 'unknown', message: errMsg(err) };
  } finally {
    await browser.close().catch(() => {});
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
