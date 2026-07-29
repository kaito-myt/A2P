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
const AMZ_PASS = process.env.AMAZON_PASSWORD || '';
const OTP_SEL = '#auth-mfa-otpcode, input[name="otpCode"], #cvf-input-code, input[name="code"]';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const dbUrl = process.env.DBURL || process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!dbUrl) { console.error('DBURL 未設定'); process.exit(1); }

async function dbClient() {
  const c = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  c.on('error', () => {});
  await c.connect();
  return c;
}

async function passReauth(page) {
  const authForm = async () => page.$('#ap_password, input[type="password"][name="password"], #signInSubmit, ' + OTP_SEL).catch(() => null);
  if (!(await authForm())) return true;
  log('🔐 再認証要求 → パスワード自動入力');
  for (let i = 0; i < 60; i++) {
    const passEl = await page.$('#ap_password, input[type="password"][name="password"]').catch(() => null);
    if (passEl && (await passEl.isVisible().catch(() => false)) && AMZ_PASS) {
      await passEl.click().catch(() => {}); await passEl.fill('').catch(() => {});
      await passEl.type(AMZ_PASS, { delay: 30 }).catch(() => {});
      await page.check('#auth-remember-me, #rememberMe').catch(() => {});
      await page.click('#signInSubmit, input#signInSubmit').catch(() => {});
      await page.waitForTimeout(4000);
    }
    const otpEl = await page.$(OTP_SEL).catch(() => null);
    if (otpEl && (await otpEl.isVisible().catch(() => false))) log('⏳ OTP をブラウザで手入力してください(最大3分)');
    await page.waitForTimeout(3000);
    if (!(await authForm())) return true;
  }
  return false;
}

/** タイトルで検索し、一致行から {asin, priceJpy} を抽出する。 */
async function lookup(page, title) {
  await page.goto(BOOKSHELF, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await passReauth(page);
  const sb = await page.$('input[type="search"], input[aria-label*="検索"], input[placeholder*="検索"], input[name*="search"]').catch(() => null);
  if (!sb) return { error: 'no_search_box' };
  // タイトル先頭 20 文字程度で検索(長すぎると検索が滑る)
  const q = title.slice(0, 24);
  await sb.fill(''); await sb.fill(q); await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);

  // 各行(dots メニューを持つコンテナ)を走査し、タイトルを含む行のテキストを取る。
  const rows = await page.$$('button[id$="-other-actions-announce"]');
  if (rows.length === 0) return { error: 'not_found' };
  const results = [];
  for (const dots of rows) {
    const text = await page.evaluate((el) => {
      let n = el; for (let i = 0; i < 7 && n; i++) { const t = n.textContent || ''; if (t.trim().length > 30) return t; n = n.parentElement; }
      return el.textContent || '';
    }, dots).catch(() => '');
    results.push(text);
  }
  // タイトル(先頭12字)を含む行を優先。無ければ最初の行。
  const key = title.slice(0, 12);
  const rowText = results.find((t) => t.includes(key)) || (rows.length === 1 ? results[0] : null);
  if (!rowText) return { error: `ambiguous(${rows.length})`, rows: results.map((t) => t.slice(0, 60)) };

  const asinM = rowText.match(/B0[A-Z0-9]{8}/);
  // 価格: 「￥1,234」「1,234 円」「¥ 500」等
  const priceM = rowText.match(/[¥￥]\s*([\d,]+)/) || rowText.match(/([\d,]+)\s*円/);
  return {
    asin: asinM ? asinM[0] : null,
    priceJpy: priceM ? Number(priceM[1].replace(/,/g, '')) : null,
    live: /販売中|ライブ|Live/i.test(rowText),
    raw: rowText.slice(0, 120),
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
      const r = await lookup(page, b.title);
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
