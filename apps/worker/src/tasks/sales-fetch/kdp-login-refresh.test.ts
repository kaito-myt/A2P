import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  looksLikeCaptcha,
  isLoggedIn,
  handleOtpRetryLoop,
  refreshKdpSession,
  type OtpCapablePage,
} from './kdp-login-refresh.js';

// ---------------------------------------------------------------------------
// looksLikeCaptcha
// ---------------------------------------------------------------------------

describe('looksLikeCaptcha', () => {
  it('cvf_captcha_input を含めば true', () => {
    expect(looksLikeCaptcha('<input id="cvf_captcha_input">')).toBe(true);
  });

  it('auth-captcha-image を含めば true', () => {
    expect(looksLikeCaptcha('<img id="auth-captcha-image" src="...">')).toBe(true);
  });

  it('日本語の「画像に表示されている文字」パターンで true', () => {
    expect(looksLikeCaptcha('画像に表示されている文字を入力してください8文字')).toBe(true);
  });

  it('英語の characters you see パターンで true', () => {
    expect(looksLikeCaptcha('Type the characters you see in this image')).toBe(true);
  });

  it('単に captcha の語があるだけ(隠しマークアップ)では false — 誤検知防止', () => {
    expect(looksLikeCaptcha('<script>var captchaConfig={};</script>')).toBe(false);
  });

  it('通常のログインページ HTML では false', () => {
    expect(looksLikeCaptcha('<html><body><input id="ap_email"></body></html>')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isLoggedIn
// ---------------------------------------------------------------------------

describe('isLoggedIn', () => {
  it('bookshelf URL かつ認証フィールドが無ければ true', () => {
    expect(isLoggedIn('https://kdp.amazon.co.jp/ja_JP/bookshelf', false)).toBe(true);
  });

  it('bookshelf URL でも認証フィールドが残っていれば false', () => {
    expect(isLoggedIn('https://kdp.amazon.co.jp/ja_JP/bookshelf', true)).toBe(false);
  });

  it('signin を含む URL は false', () => {
    expect(isLoggedIn('https://www.amazon.co.jp/ap/signin?openid.return_to=bookshelf', false)).toBe(false);
  });

  it('bookshelf を含まない URL は false', () => {
    expect(isLoggedIn('https://kdp.amazon.co.jp/ja_JP/title-setup', false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// refreshKdpSession: no_creds 早期リターン (実ブラウザ起動なし)
// ---------------------------------------------------------------------------

describe('refreshKdpSession (no_creds)', () => {
  const prevEmail = process.env.AMAZON_EMAIL;
  const prevPassword = process.env.AMAZON_PASSWORD;

  beforeEach(() => {
    delete process.env.AMAZON_EMAIL;
    delete process.env.AMAZON_PASSWORD;
  });

  afterEach(() => {
    if (prevEmail === undefined) delete process.env.AMAZON_EMAIL;
    else process.env.AMAZON_EMAIL = prevEmail;
    if (prevPassword === undefined) delete process.env.AMAZON_PASSWORD;
    else process.env.AMAZON_PASSWORD = prevPassword;
  });

  it('AMAZON_EMAIL/AMAZON_PASSWORD が未設定なら no_creds を即返す (playwright を起動しない)', async () => {
    const result = await refreshKdpSession({
      prisma: { kdpAuthRequest: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() } },
    });
    expect(result).toEqual({ ok: false, reason: 'no_creds', message: expect.any(String) });
  });

  it('AMAZON_EMAIL のみ設定されていても no_creds', async () => {
    process.env.AMAZON_EMAIL = 'operator@example.com';
    const result = await refreshKdpSession({
      prisma: { kdpAuthRequest: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_creds');
  });
});

// ---------------------------------------------------------------------------
// handleOtpRetryLoop: OTP 再送ループ (fake page, 実ブラウザ不使用)
// ---------------------------------------------------------------------------

function makeFakeOtpPage(visibilitySequence: boolean[]): OtpCapablePage {
  // visibilitySequence[i] = i 回目の click 後に isVisible() が返す値 (true=まだ入力欄が残っている=失敗)。
  let clickCount = 0;
  const element = {
    fill: vi.fn().mockResolvedValue(undefined),
    // clickCount は直前の click() 実行時にインクリメント済みなので -1 して参照する。
    isVisible: vi.fn().mockImplementation(() => Promise.resolve(visibilitySequence[clickCount - 1] ?? false)),
  };
  return {
    $: vi.fn().mockResolvedValue(element),
    check: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockImplementation(() => {
      clickCount++;
      return Promise.resolve();
    }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  };
}

describe('handleOtpRetryLoop', () => {
  it('1回目の送信で成功 (入力欄が消える)', async () => {
    const page = makeFakeOtpPage([false]);
    const requestOtp = vi.fn().mockResolvedValue('111111');
    const notifyFailure = vi.fn().mockResolvedValue(true);

    const result = await handleOtpRetryLoop(page, { requestOtp, notifyFailure });

    expect(result).toEqual({ ok: true });
    expect(requestOtp).toHaveBeenCalledTimes(1);
    expect(notifyFailure).not.toHaveBeenCalled();
  });

  it('1回失敗(コード不正)して通知のうえ2回目で成功', async () => {
    const page = makeFakeOtpPage([true, false]);
    const requestOtp = vi.fn().mockResolvedValueOnce('111111').mockResolvedValueOnce('222222');
    const notifyFailure = vi.fn().mockResolvedValue(true);

    const result = await handleOtpRetryLoop(page, { requestOtp, notifyFailure });

    expect(result).toEqual({ ok: true });
    expect(requestOtp).toHaveBeenCalledTimes(2);
    expect(notifyFailure).toHaveBeenCalledTimes(1);
    expect(notifyFailure).toHaveBeenCalledWith(expect.stringContaining('認証コードが正しくないか期限切れ'));
  });

  it('maxAttempts 回すべて失敗し続ければ login_failed', async () => {
    const page = makeFakeOtpPage([true, true, true]);
    const requestOtp = vi.fn().mockResolvedValue('111111');
    const notifyFailure = vi.fn().mockResolvedValue(true);

    const result = await handleOtpRetryLoop(page, { requestOtp, notifyFailure, maxAttempts: 3 });

    expect(result).toEqual({ ok: false, reason: 'login_failed', message: expect.any(String) });
    expect(requestOtp).toHaveBeenCalledTimes(3);
    // 最後の失敗時は通知しない (これ以上リトライしないため)
    expect(notifyFailure).toHaveBeenCalledTimes(2);
  });

  it('requestOtp が null を返す (LINE リレータイムアウト) → otp_timeout', async () => {
    const page = makeFakeOtpPage([true]);
    const requestOtp = vi.fn().mockResolvedValueOnce('111111').mockResolvedValueOnce(null);
    const notifyFailure = vi.fn().mockResolvedValue(true);

    const result = await handleOtpRetryLoop(page, { requestOtp, notifyFailure, maxAttempts: 3 });

    expect(result).toEqual({ ok: false, reason: 'otp_timeout', message: expect.any(String) });
    expect(requestOtp).toHaveBeenCalledTimes(2);
  });
});
