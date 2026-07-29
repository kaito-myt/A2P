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
const REMEMBER_ME_SELECTOR = '#rememberMe, #auth-remember-me';
const SIGNIN_SUBMIT_SELECTOR = '#signInSubmit, input#signInSubmit';
const OTP_SELECTOR = '#auth-mfa-otpcode, input[name="otpCode"], #cvf-input-code, input[name="code"]';
const REMEMBER_DEVICE_SELECTOR = '#auth-mfa-remember-device';
const OTP_SUBMIT_SELECTOR = '#auth-signin-button, #cvf-submit-otp-button, input[type="submit"]';
/** 実際に表示される CAPTCHA チャレンジ要素。HTML 文字列一致だと通常サインインの隠しマークアップで誤検知するため、可視要素で判定する。 */
const CAPTCHA_SELECTOR =
  '#auth-captcha-image, #captchacharacters, input[name="cvf_captcha_input"], #cvf_captcha_input, img[alt*="captcha" i], img[src*="captcha" i]';
/** signin URL / アカウント切替ウィジェットの検知。max_auth_age=0 の再認証はアカウント選択から始まる。 */
const SIGNIN_URL_RE = /signin|\/ap\//i;

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
 *
 * NOTE: 通常のサインイン/パスワードページにも "captcha" の文字列や cvf の隠し要素が
 * 埋め込まれているため、単なる文字列一致だと誤検知する (アカウント選択→パスワード遷移で
 * 頻発した)。実運用のループでは本関数ではなく `CAPTCHA_SELECTOR` の「可視要素」判定を使う。
 * 本関数は「明確に CAPTCHA を指す固有マーカー / 提示文言」のみで true を返す補助判定。
 */
export function looksLikeCaptcha(html: string): boolean {
  return (
    html.includes('cvf_captcha_input') ||
    html.includes('auth-captcha-image') ||
    html.includes('captchacharacters') ||
    /画像に表示されている文字|表示されている文字を入力/.test(html) ||
    /type the characters you see|enter the characters/i.test(html)
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
      // CAPTCHA は「実際に表示されている要素」でのみ判定する。HTML 文字列一致だと
      // 通常サインインの隠しマークアップで誤検知し、パスワード段階に進めなくなる。
      const captchaEl = await page.$(CAPTCHA_SELECTOR).catch(() => null);
      if (captchaEl && (await captchaEl.isVisible().catch(() => false))) {
        return {
          ok: false,
          reason: 'captcha',
          message: 'visible CAPTCHA challenge detected — cannot solve headlessly',
        };
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
        // .fill だと Amazon 側の検証が発火しないことがあるため click→clear→type で確実に入力する。
        await passEl.click().catch(() => {});
        await passEl.fill('').catch(() => {});
        await passEl.type(password, { delay: 25 }).catch(() => {});
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

      // アカウント選択ページ (アカウントの切り替え): max_auth_age=0 の再認証は
      // email/password/OTP のいずれも表示されないこの画面から始まることが多い。
      // 保存済みアカウントのタイルをクリックしてパスワード画面へ進める。
      // これが無いとサインインページで何もできずタイムアウトしていた (実障害の原因)。
      if (SIGNIN_URL_RE.test(page.url())) {
        const picked = await clickAccountTile(page, email);
        if (picked) {
          log.info({ picked }, 'clicked account-picker tile');
          await page.waitForTimeout(3500);
          continue;
        }
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

/**
 * アカウント選択ページで、保存済みメールアドレスに一致するアカウントのタイルを
 * クリックする。見つからなければ「@ を含む(=アカウントらしい)最初のタイル」に
 * フォールバックする。クリックできたらそのラベル(先頭40字)を、無ければ null を返す。
 * scripts/kdp-backfill-asin.mjs の passReauth で実 KDP 検証済みのロジックを移植したもの。
 */
async function clickAccountTile(
  page: import('playwright').Page,
  email: string,
): Promise<string | null> {
  return page
    .evaluate((mail) => {
      const t = (mail || '').toLowerCase();
      const nodes = Array.from(
        document.querySelectorAll('a, div[role="button"], button, [data-a-target], .a-link-normal'),
      ) as HTMLElement[];
      const hit =
        (t ? nodes.find((n) => (n.textContent || '').toLowerCase().includes(t)) : undefined) ??
        nodes.find(
          (n) =>
            !/アカウントの追加|別のアカウント/.test(n.textContent || '') &&
            /@/.test(n.textContent || ''),
        );
      if (hit) {
        hit.click();
        return (hit.textContent || '').trim().slice(0, 40);
      }
      return null;
    }, email)
    .catch(() => null);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
