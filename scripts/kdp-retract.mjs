// KDP 出版取り消し(unpublish)＋アーカイブ を ASIN 指定で行う。
// 使い方: node scripts/kdp-retract.mjs B0XXXXXXXX  (env: AMAZON_EMAIL/PASSWORD, 再認証用)
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
const reqWorker = createRequire('C:/DEV/A2P/apps/worker/package.json');
const chromium = reqWorker('playwright').chromium;

const ASIN = (process.argv[2] || '').trim();
if (!/^B0[A-Z0-9]{8}$/.test(ASIN)) { console.error('usage: node kdp-retract.mjs <ASIN>'); process.exit(1); }
const USERDATA = 'C:/DEV/A2P/scripts/.kdp-userdata';
const BOOKSHELF = 'https://kdp.amazon.co.jp/ja_JP/bookshelf';
const STAGE = path.join(os.tmpdir(), 'kdp-publish-stage');
const AMZ_EMAIL = process.env.AMAZON_EMAIL || '';
const AMZ_PASS = process.env.AMAZON_PASSWORD || '';
const OTP_SEL = '#auth-mfa-otpcode, input[name="otpCode"], #cvf-input-code, input[name="code"]';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function passReauth(page) {
  const authForm = async () => page.$('#ap_password, input[type="password"][name="password"], #signInSubmit, ' + OTP_SEL).catch(() => null);
  if (!(await authForm())) return true;
  log('🔐 再認証要求 → パスワード自動入力');
  for (let i = 0; i < 100; i++) {
    const passEl = await page.$('#ap_password, input[type="password"][name="password"]').catch(() => null);
    if (passEl && (await passEl.isVisible().catch(() => false)) && AMZ_PASS) {
      await passEl.click().catch(() => {}); await passEl.fill('').catch(() => {});
      await passEl.type(AMZ_PASS, { delay: 30 }).catch(() => {});
      await page.check('#auth-remember-me, #rememberMe').catch(() => {});
      await page.click('#signInSubmit, input#signInSubmit').catch(() => {});
      await page.waitForTimeout(4000);
    }
    const otpEl = await page.$(OTP_SEL).catch(() => null);
    if (otpEl && (await otpEl.isVisible().catch(() => false))) { log('⏳ OTPが必要です。ブラウザで手入力してください(最大5分)'); }
    await page.waitForTimeout(3000);
    if (!(await authForm())) return true;
  }
  return false;
}

async function search(page) {
  await page.goto(BOOKSHELF, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(6000);
  await passReauth(page);
  const sb = await page.$('input[type="search"], input[aria-label*="検索"], input[placeholder*="検索"], input[name*="search"]').catch(() => null);
  if (sb) { await sb.fill('').catch(() => {}); await sb.fill(ASIN).catch(() => {}); await page.keyboard.press('Enter').catch(() => {}); await page.waitForTimeout(6000); }
  const found = await page.evaluate((a) => (document.body.textContent || '').includes(a), ASIN);
  const dots = await page.$$('button[id$="-other-actions-announce"]');
  return { found, dots: dots.length };
}

(async () => {
  const ctx = await chromium.launchPersistentContext(USERDATA, { headless: false, channel: 'chrome', locale: 'ja-JP', viewport: { width: 1500, height: 1100 }, args: ['--disable-blink-features=AutomationControlled'] });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.setDefaultTimeout(60000);
  try {
    let s = await search(page);
    log('search', ASIN, '→ found=', s.found, 'menus=', s.dots);
    if (!s.found) { log('見つかりません(既に取り消し済み?)。終了'); await ctx.close(); return; }
    if (s.dots !== 1) { log('検索結果が1件でない(', s.dots, ') → 中断'); await page.screenshot({ path: path.join(STAGE, 'retract-ambiguous.png'), fullPage: true }).catch(() => {}); await ctx.close(); return; }
    // 1) unpublish
    await page.click('button[id$="-other-actions-announce"]').catch(() => {});
    await page.waitForTimeout(2000);
    const unpub = await page.$('a[id^="unpublish-"]');
    if (unpub && (await unpub.isVisible().catch(() => false))) {
      await unpub.click().catch(() => {});
      await page.waitForTimeout(2500);
      const confirm = await page.$('#confirm-unpublish-announce');
      if (confirm && (await confirm.isVisible().catch(() => false))) {
        await confirm.click().catch(() => {});
        await page.waitForTimeout(6000);
        log('✅ 出版取り消し(unpublish)完了');
      } else { log('⚠ unpublish確認ダイアログなし'); }
    } else { log('⚠ unpublishリンクなし(既に非公開?)'); }
    await page.screenshot({ path: path.join(STAGE, 'retract-after-unpublish.png'), fullPage: true }).catch(() => {});
    // 2) archive (下書きに変わっているはず → メニューからアーカイブ)
    s = await search(page);
    if (s.found && s.dots === 1) {
      await page.click('button[id$="-other-actions-announce"]').catch(() => {});
      await page.waitForTimeout(2000);
      const arch = await page.$('a[id^="digital_archive_title-"]');
      if (arch && (await arch.isVisible().catch(() => false))) {
        await arch.click().catch(() => {});
        await page.waitForTimeout(2500);
        const confirm = await page.$('#archive-title-ok-announce');
        if (confirm && (await confirm.isVisible().catch(() => false))) {
          await confirm.click().catch(() => {});
          await page.waitForTimeout(5000);
          log('✅ アーカイブ完了');
        } else { log('⚠ archive確認ダイアログなし'); }
      } else { log('⚠ archiveリンクなし'); }
    } else { log('取り消し後の再検索: found=', s.found, 'menus=', s.dots, '(アーカイブskip)'); }
    await page.screenshot({ path: path.join(STAGE, 'retract-final.png'), fullPage: true }).catch(() => {});
    log('完了');
  } catch (e) {
    log('ERROR:', e.message);
    await page.screenshot({ path: path.join(STAGE, 'retract-error.png'), fullPage: true }).catch(() => {});
  } finally {
    await page.waitForTimeout(2000);
    await ctx.close();
  }
})();
