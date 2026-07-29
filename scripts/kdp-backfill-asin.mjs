// KDP 本棚から「実 ASIN・実価格」を取得し DB に backfill する (READ-ONLY 操作)。
// books.asin が NULL の出版済み/入稿済み本を対象に、タイトル検索→行から ASIN と価格を抽出し、
// books.asin / kdp_metadata.price_jpy を更新する。破壊的操作(取り下げ/削除)は一切しない。
//
// 使い方: bash scripts/kdp-backfill.sh   (env: DBURL, AMAZON_EMAIL/PASSWORD 再認証用)
//         node scripts/kdp-backfill-asin.mjs [--dry-run] [--all]
//   --dry-run: DB を更新せず抽出結果だけ表示
//   --all    : asin が既にある本も価格を再確認して更新
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
const reqWorker = createRequire('C:/DEV/A2P/apps/worker/package.json');
const reqPg = createRequire('C:/DEV/A2P/node_modules/.pnpm/pg@8.21.0/node_modules/pg/');
const chromium = reqWorker('playwright').chromium;
const { Client } = reqPg('pg');

const DRY = process.argv.includes('--dry-run');
const ALL = process.argv.includes('--all');
const USERDATA = 'C:/DEV/A2P/scripts/.kdp-userdata';
const BOOKSHELF = 'https://kdp.amazon.co.jp/ja_JP/bookshelf';
const STAGE = path.join(os.tmpdir(), 'kdp-publish-stage');
const AMZ_EMAIL = process.env.AMAZON_EMAIL || '';
const AMZ_PASS = process.env.AMAZON_PASSWORD || '';
const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_USER = process.env.LINE_USER_ID || process.env.LINE_ALLOWED_USER_ID || '';
const OTP_SEL = '#auth-mfa-otpcode, input[name="otpCode"], #cvf-input-code, input[name="code"]';
const MAX_OTP_ROUNDS = 3;
const genId = () => 'kar_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function pushLine(text) {
  if (!LINE_TOKEN || !LINE_USER) { log('  LINE未設定 — push省略'); return false; }
  try {
    const res = await fetch(LINE_PUSH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_TOKEN }, body: JSON.stringify({ to: LINE_USER, messages: [{ type: 'text', text }] }) });
    if (!res.ok) { log('  LINE push失敗', res.status); return false; }
    return true;
  } catch (e) { log('  LINE push例外', e.message); return false; }
}

const dbUrl = process.env.DBURL || process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!dbUrl) { console.error('DBURL 未設定'); process.exit(1); }

async function dbClient() {
  const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  return c;
}

// 認証待ちを1件作成 → LINE通知 → 5分ポーリング。code | null。
async function awaitOtpOnce(db, page, prompt) {
  const id = genId();
  const expires = new Date(Date.now() + 5 * 60 * 1000);
  await db.query(`INSERT INTO kdp_auth_requests (id, purpose, status, prompt, expires_at) VALUES ($1,'kdp_login_otp','pending',$2,$3)`, [id, prompt, expires]);
  const ok = await pushLine(prompt);
  if (!ok) log('  ※LINE未送信だがDBに認証待ち作成済(webhook経由で受信可)');
  for (let i = 0; i < 150; i++) {
    const r = await db.query(`SELECT code, status FROM kdp_auth_requests WHERE id=$1`, [id]);
    const row = r.rows[0];
    if (row && row.status === 'fulfilled' && row.code) { await db.query(`UPDATE kdp_auth_requests SET status='consumed', consumed_at=now() WHERE id=$1`, [id]); return row.code; }
    await page.waitForTimeout(2000);
  }
  await db.query(`UPDATE kdp_auth_requests SET status='expired' WHERE id=$1 AND status='pending'`, [id]);
  return null;
}

async function relayOtpViaLine(db, page, otpInput) {
  for (let round = 1; round <= MAX_OTP_ROUNDS; round++) {
    const prompt = round === 1
      ? '🔐 A2P: KDP本棚の読み取りにログイン認証が必要です。\n認証アプリの6桁コードをこのトークに返信してください（5分以内）。'
      : `🔁 A2P: 認証コードを再送してください（${round}/${MAX_OTP_ROUNDS}）。最新の6桁コードを返信してください（5分以内）。`;
    log(`  LINE認証リレー round ${round}/${MAX_OTP_ROUNDS} — 返信待機中...`);
    const code = await awaitOtpOnce(db, page, prompt);
    if (!code) { await pushLine('⏰ A2P: コード未受信。もう一度送っていただければ再開します。'); continue; }
    let el = otpInput;
    if (!(await el?.isVisible().catch(() => false))) el = await page.$(OTP_SEL).catch(() => null);
    if (el) await el.fill(code).catch(() => {});
    await page.check('#auth-mfa-remember-device').catch(() => {});
    const submit = (await page.$('#auth-signin-button').catch(() => null)) ? '#auth-signin-button' : (await page.$('#cvf-submit-otp-button').catch(() => null)) ? '#cvf-submit-otp-button' : 'input[type="submit"]';
    await page.click(submit).catch(() => {});
    await page.waitForTimeout(5000);
    const stillOtp = await page.$(OTP_SEL).catch(() => null);
    if (!(stillOtp && (await stillOtp.isVisible().catch(() => false)))) { log('  認証成功'); return true; }
    await pushLine('❌ A2P: コードが不正/期限切れでした。新しい6桁コードを送ってください。');
    otpInput = stillOtp;
  }
  return false;
}

// アカウント選択画面 → パスワード → OTP を通す。認証フォームが無ければ即通過。
async function passReauth(page, db) {
  const authFormOrPicker = async () =>
    page.$('#ap_password, input[type="password"][name="password"], #signInSubmit, #ap_email, ' + OTP_SEL + ', a[href*="signin"], .cvf-account-switcher-spacing, [data-name="accountSwitcher"]').catch(() => null);
  if (!/signin|\/ap\//i.test(page.url()) && !(await authFormOrPicker())) return true;
  log('  🔐 再認証(reauth)要求 → 自動通過を試行');
  let autoTries = 0;
  for (let i = 0; i < 120; i++) {
    // アカウント選択画面: 対象アカウントのタイルをクリックしてパスワード画面へ。
    if (!(await page.$('#ap_password, input[type="password"][name="password"]').catch(() => null))) {
      const picked = await page.evaluate((email) => {
        const nodes = Array.from(document.querySelectorAll('a, div[role="button"], button, [data-a-target], .a-link-normal'));
        const t = (email || '').toLowerCase();
        const hit = nodes.find((n) => (n.textContent || '').toLowerCase().includes(t) && t) ||
                    nodes.find((n) => /アカウントの追加|別のアカウント/.test(n.textContent || '') === false && /@/.test(n.textContent || ''));
        if (hit) { hit.click(); return (hit.textContent || '').trim().slice(0, 40); }
        return null;
      }, AMZ_EMAIL).catch(() => null);
      if (picked) { log('  アカウント選択:', picked); await page.waitForTimeout(3500); }
    }
    // email 入力(稀)
    const emailEl = await page.$('#ap_email, input[type="email"][name="email"]').catch(() => null);
    if (emailEl && AMZ_EMAIL && (await emailEl.isVisible().catch(() => false))) {
      await emailEl.fill(AMZ_EMAIL).catch(() => {}); await page.click('#continue, input#continue').catch(() => {}); await page.waitForTimeout(2500);
    }
    // OTP → LINE
    const otpEl = await page.$(OTP_SEL).catch(() => null);
    if (otpEl && (await otpEl.isVisible().catch(() => false))) { if (!(await relayOtpViaLine(db, page, otpEl))) return false; }
    // password 自動入力(最大3回)
    const passEl = await page.$('#ap_password, input[type="password"][name="password"]').catch(() => null);
    if (passEl && (await passEl.isVisible().catch(() => false)) && AMZ_PASS && autoTries < 3) {
      autoTries++;
      await passEl.click().catch(() => {}); await passEl.fill('').catch(() => {});
      await passEl.type(AMZ_PASS, { delay: 25 }).catch(() => {});
      await page.check('#auth-remember-me, #rememberMe').catch(() => {});
      await page.click('#signInSubmit, input#signInSubmit').catch(() => {});
      await page.waitForTimeout(4000);
    }
    // 通過判定: bookshelf に到達 or 認証要素が消えた
    if (/\/bookshelf/.test(page.url()) && !/signin/i.test(page.url())) return true;
    if (!/signin|\/ap\//i.test(page.url()) && !(await page.$('#ap_password, ' + OTP_SEL).catch(() => null))) { await page.waitForTimeout(1500); return true; }
    await page.waitForTimeout(2500);
  }
  return false;
}

/** 検索ボックスをリトライ付きで取得。reauth 直後の遷移で null になることがある。 */
async function getSearchBox(page, db) {
  for (let i = 0; i < 6; i++) {
    await passReauth(page, db);
    const sb = await page.$('input[type="search"], input[aria-label*="検索"], input[placeholder*="検索"], input[name*="search"]').catch(() => null);
    if (sb && (await sb.isVisible().catch(() => false))) return sb;
    await page.waitForTimeout(2500);
  }
  return null;
}

/**
 * タイトルで検索し、ページ上の ASIN/価格を安全に抽出する。
 * 誤登録を避けるため「ページ上の live な B0 ASIN が一意のときだけ」採用する
 * (複数ヒットは ambiguous としてスキップ)。価格は表示があれば拾い、無ければ null(据え置き)。
 */
async function lookup(db, page, title) {
  await page.goto(BOOKSHELF, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000);
  const sb = await getSearchBox(page, db);
  if (!sb) return { error: 'no_search_box' };
  await sb.fill(''); await sb.fill(title.trim()); await page.keyboard.press('Enter');
  await page.waitForTimeout(6000);

  const info = await page.evaluate(() => {
    const html = document.documentElement.outerHTML;
    const asins = [...new Set((html.match(/B0[A-Z0-9]{8}/g) || []))];
    const prices = [...new Set((html.match(/[¥￥]\s*[\d,]{2,}/g) || []))].map((s) => Number(s.replace(/[¥￥,\s]/g, ''))).filter((n) => n >= 99 && n <= 5000);
    const dots = document.querySelectorAll('button[id$="-other-actions-announce"]').length;
    const live = document.querySelectorAll('[id*="live-book-actions"]').length;
    const bodyText = (document.body.textContent || '');
    return { asins, prices, dots, live, hasReview: /レビュー中|出版準備中/.test(bodyText), hasLive: /販売中|ライブ/.test(bodyText) };
  }).catch(() => null);
  if (!info) return { error: 'eval_failed' };
  if (info.dots === 0 && info.asins.length === 0) return { error: 'not_found' };
  if (info.asins.length !== 1) return { error: `ambiguous(asins=${info.asins.length},dots=${info.dots})`, asins: info.asins };

  return {
    asin: info.asins[0],
    priceJpy: info.prices.length === 1 ? info.prices[0] : null, // 価格も一意のときだけ採用
    live: info.hasLive || info.live > 0,
    raw: `dots=${info.dots} prices=${JSON.stringify(info.prices)} review=${info.hasReview} live=${info.hasLive}`,
  };
}

(async () => {
  const db = await dbClient();
  const where = ALL
    ? `(b.publish_status IN ('submitted','published') OR b.status IN ('done','external'))`
    : `b.asin IS NULL AND (b.publish_status IN ('submitted','published') OR b.status IN ('done','external'))`;
  const { rows: books } = await db.query(
    `SELECT b.id, b.title, b.asin, km.price_jpy
     FROM books b LEFT JOIN kdp_metadata km ON km.book_id=b.id
     WHERE ${where} ORDER BY b.updated_at DESC`
  );
  log(`対象 ${books.length} 冊 (dry-run=${DRY}, all=${ALL})`);

  const ctx = await chromium.launchPersistentContext(USERDATA, { headless: false, channel: 'chrome', locale: 'ja-JP', viewport: { width: 1500, height: 1100 }, args: ['--disable-blink-features=AutomationControlled'] });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.setDefaultTimeout(60000);

  let updated = 0, failed = 0;
  try {
    for (const b of books) {
      const r = await lookup(db, page, b.title);
      if (r.error) { log(`❓ ${b.title.slice(0, 20)} → ${r.error}`, r.rows ? JSON.stringify(r.rows) : ''); failed++; continue; }
      log(`📗 ${b.title.slice(0, 20)} → asin=${r.asin} price=${r.priceJpy} live=${r.live} | ${r.raw}`);
      if (!r.asin) { failed++; continue; }
      if (!DRY) {
        // asin は UNIQUE。既に別 book が同 asin を持つ場合は衝突するので存在チェック。
        const dup = await db.query(`SELECT id FROM books WHERE asin=$1 AND id<>$2`, [r.asin, b.id]);
        if (dup.rows.length > 0) { log(`⚠ asin ${r.asin} は別の book が既に保持 → skip`); failed++; continue; }
        await db.query(`UPDATE books SET asin=$1, updated_at=now() WHERE id=$2`, [r.asin, b.id]);
        if (r.priceJpy && r.priceJpy !== b.price_jpy) {
          await db.query(
            `UPDATE kdp_metadata SET price_jpy=$1, updated_at=now() WHERE book_id=$2`,
            [r.priceJpy, b.id]
          );
          log(`   price ${b.price_jpy} → ${r.priceJpy}`);
        }
        updated++;
      }
    }
  } catch (e) {
    log('ERROR', e.message);
    await page.screenshot({ path: path.join(STAGE, 'backfill-error.png'), fullPage: true }).catch(() => {});
  } finally {
    log(`完了: updated=${updated} failed=${failed}`);
    await page.waitForTimeout(1500);
    await ctx.close();
    await db.end();
  }
})();
