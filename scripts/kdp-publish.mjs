/**
 * KDP 自動出版ツール（運営者アシスト型）。
 *
 * 背景・前提（重要）:
 *  - KDP は新規タイトル作成時に max_auth_age=0 の再認証を強制するため、完全ヘッドレス（Railway）出版は不可能。
 *    本ツールはローカルで headful 起動し、運営者が一度だけフレッシュログイン（パスワード+2FA）すれば、
 *    以降ウィザード（詳細→コンテンツ→価格→出版）を全自動で回す。
 *  - さらに Amazon 側の「本の作成数制限」が有効な間は、いくらフォームを正しく埋めても新規作成が拒否される
 *    （保存して続行 → 「本の作成数制限を超えました」モーダル）。本ツールはこれを検出して当該書籍を skip し、
 *    残りを試行する。制限解除後に再実行すれば、未出版の本が順次出版される（＝手動リトライ運用）。
 *
 * 使い方:
 *   # 環境変数(必須): DBURL(=prod DATABASE_PUBLIC_URL), R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME
 *   # 環境変数(任意/LINE認証リレー): LINE_CHANNEL_ACCESS_TOKEN, LINE_USER_ID(=通知先/自分のuserId)
 *   #   → OTP画面に到達するとLINEに通知が飛び、返信した6桁コードを自動入力する。
 *   # 環境変数(任意/ログイン自動入力): AMAZON_EMAIL, AMAZON_PASSWORD(未設定ならブラウザで手入力)
 *   node scripts/kdp-publish.mjs                      # 既定: 入稿キュー(kdp_publish_queued=true)の本を全部出版
 *   node scripts/kdp-publish.mjs --dry-run            # 出版直前まで（最後の「出版」を押さない）
 *   node scripts/kdp-publish.mjs --book-id=<id>       # 1冊だけ
 *   node scripts/kdp-publish.mjs --limit=1            # 最大N冊
 *   node scripts/kdp-publish.mjs --all                # 従来挙動: 未出品(done/unlisted)全冊
 *
 * A2P の「自動入稿/一括自動入稿」ボタンで本を入稿キューに登録 → 本ツールを1回ログインして流すと
 * キューの本だけ自動入稿し、成功した本は kdp_publish_queued=false + publish_status='submitted' に更新。
 *
 * セレクタは実 KDP で検証済み（2026-07-25）。Step1(詳細)は実証済み、Step2/3 は既存本の編集ページから
 * リバースエンジニアリング（作成数制限のため新規作成での実地検証は制限解除後）。
 */
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url.startsWith('file:') ? new URL(import.meta.url).pathname.replace(/^\//, '') : 'C:/DEV/A2P/scripts/kdp-publish.mjs');
const reqWorker = createRequire('C:/DEV/A2P/apps/worker/package.json');
const reqPg = createRequire('C:/DEV/A2P/node_modules/.pnpm/pg@8.21.0/node_modules/pg/');
const reqS3 = createRequire('C:/DEV/A2P/packages/storage/index.js');

const pw = reqWorker('playwright');
const chromium = pw.chromium ?? pw.default?.chromium;
const { Client } = reqPg('pg');
const { S3Client, GetObjectCommand } = reqS3('@aws-sdk/client-s3');

// ---- args ----
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BOOK_ID = (args.find((a) => a.startsWith('--book-id=')) || '').split('=')[1] || null;
const LIMIT = parseInt((args.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || '99', 10);
// 既定は UI「自動入稿/一括自動入稿」で登録された入稿キュー (kdp_publish_queued=true) のみを対象にする。
// --all で従来挙動 (done+unlisted 全件)。--book-id 指定時はその本のみ。
const ALL_MODE = args.includes('--all');
const USERDATA = 'C:/DEV/A2P/scripts/.kdp-userdata';
const CREATE = 'https://kdp.amazon.co.jp/action/mangaactions.createkindle/ja_JP/title-setup/kindle/new/details';
const BOOKSHELF = 'https://kdp.amazon.co.jp/ja_JP/bookshelf';
const STAGE = path.join(os.tmpdir(), 'kdp-publish-stage');
fs.mkdirSync(STAGE, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- LINE 認証リレー / ログイン自動入力の設定 ----
const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_USER = process.env.LINE_USER_ID || process.env.LINE_ALLOWED_USER_ID || '';
const AMZ_EMAIL = process.env.AMAZON_EMAIL || '';
const AMZ_PASS = process.env.AMAZON_PASSWORD || '';

const genId = () => 'kar_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const isOnDetails = (page) =>
  /title-setup\/kindle\/[^/]+\/details/.test(page.url()) && !/signin/i.test(page.url());

// LINE Messaging API push（通知のみ。返信の受信は Web webhook 側 /api/line/webhook が担当）
async function pushLine(text) {
  if (!LINE_TOKEN || !LINE_USER) {
    log('  LINE未設定 (LINE_CHANNEL_ACCESS_TOKEN / LINE_USER_ID) — push省略');
    return false;
  }
  try {
    const res = await fetch(LINE_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LINE_TOKEN },
      body: JSON.stringify({ to: LINE_USER, messages: [{ type: 'text', text }] }),
    });
    if (!res.ok) {
      log('  LINE push失敗', res.status, await res.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (e) {
    log('  LINE push例外', e.message);
    return false;
  }
}

const OTP_SEL = '#auth-mfa-otpcode, input[name="otpCode"], #cvf-input-code, input[name="code"]';
const MAX_OTP_ROUNDS = 3; // タイムアウト/認証失敗ごとに再送する最大回数

// 認証待ちを1件作成 → LINE通知 → 5分ポーリング。code | null を返す。
async function awaitOtpOnce(c, page, prompt) {
  const id = genId();
  const expires = new Date(Date.now() + 5 * 60 * 1000);
  await c.query(
    `INSERT INTO kdp_auth_requests (id, purpose, status, prompt, expires_at) VALUES ($1,'kdp_login_otp','pending',$2,$3)`,
    [id, prompt, expires],
  );
  const ok = await pushLine(prompt);
  if (!ok) log('  ※LINE通知は未送信ですが、DBに認証待ちを作成済み（Web webhook経由でコード受信可）');
  for (let i = 0; i < 150; i++) {
    const r = await c.query(`SELECT code, status FROM kdp_auth_requests WHERE id=$1`, [id]);
    const row = r.rows[0];
    if (row && row.status === 'fulfilled' && row.code) {
      await c.query(`UPDATE kdp_auth_requests SET status='consumed', consumed_at=now() WHERE id=$1`, [id]);
      return row.code;
    }
    await page.waitForTimeout(2000);
  }
  await c.query(`UPDATE kdp_auth_requests SET status='expired' WHERE id=$1 AND status='pending'`, [id]);
  return null;
}

// OTP画面到達 → LINEリレー。タイムアウト/認証失敗のたびに再送して最大 MAX_OTP_ROUNDS 回試行。
async function relayOtpViaLine(c, page, otpInput, submitSel) {
  for (let round = 1; round <= MAX_OTP_ROUNDS; round++) {
    const prompt =
      round === 1
        ? '🔐 A2P: KDPログインの認証が必要です。\n認証アプリの6桁コードをこのトークに返信してください（5分以内）。'
        : `🔁 A2P: 認証コードを再送してください（${round}/${MAX_OTP_ROUNDS} 回目）。\n認証アプリに表示中の最新の6桁コードを返信してください（5分以内）。`;
    log(`  LINE認証リレー round ${round}/${MAX_OTP_ROUNDS} — 返信待機中（最大5分）...`);
    const code = await awaitOtpOnce(c, page, prompt);

    if (!code) {
      // 5分タイムアウト → 再送
      log('  コード未受信 — タイムアウト → 再送');
      await pushLine('⏰ A2P: 5分以内に認証コードが届きませんでした。もう一度コードを送っていただければ再開します。');
      continue;
    }

    log('  コード受信 → 自動入力');
    // 入力欄ハンドルが失効している場合は取り直す
    let el = otpInput;
    if (!(await el.isVisible().catch(() => false))) {
      el = await page.$(OTP_SEL).catch(() => null);
    }
    if (el) await el.fill(code).catch(() => {});
    await page.check('#auth-mfa-remember-device').catch(() => {});
    if (submitSel) await page.click(submitSel).catch(() => {});
    await page.waitForTimeout(5000);

    // 認証成否判定: OTP入力欄がまだ表示されている＝コード不正/期限切れで再入力要求
    const stillOtp = await page.$(OTP_SEL).catch(() => null);
    const rejected = stillOtp && (await stillOtp.isVisible().catch(() => false));
    if (!rejected) {
      log('  認証成功');
      return true;
    }
    log('  認証失敗（コード不正/期限切れ） → 再送');
    await pushLine('❌ A2P: 認証コードが正しくないか期限切れでした。認証アプリの新しい6桁コードを送ってください。');
    otpInput = stillOtp;
  }

  log('  認証リレー最大回数に到達 — 中断');
  await pushLine(`🛑 A2P: 認証に${MAX_OTP_ROUNDS}回失敗しました。処理を中断します。時間をおいて再実行してください。`);
  return false;
}

// ---- DB ----
function db() {
  if (!process.env.DBURL) throw new Error('DBURL env required (prod DATABASE_PUBLIC_URL)');
  return new Client({ connectionString: process.env.DBURL, ssl: false });
}
async function fetchBooks(c) {
  const where = BOOK_ID
    ? { sql: 'b.id=$1', params: [BOOK_ID] }
    : ALL_MODE
      ? { sql: "b.status='done' AND b.publish_status='unlisted'", params: [] }
      : { sql: "b.kdp_publish_queued = true AND b.publish_status <> 'published'", params: [] };
  const { rows } = await c.query(
    `SELECT b.id, b.title, b.subtitle, acc.pen_name,
       km.description, km.categories, km.keywords, km.price_jpy,
       km.title_kana, km.title_romaji, km.subtitle_kana, km.subtitle_romaji,
       km.author_kana, km.author_romaji
     FROM books b LEFT JOIN accounts acc ON acc.id=b.account_id
     LEFT JOIN kdp_metadata km ON km.book_id=b.id
     WHERE ${where.sql}
     ORDER BY b.done_at LIMIT ${LIMIT}`,
    where.params,
  );
  for (const b of rows) {
    const cov = await c.query('SELECT r2_key, status FROM covers WHERE book_id=$1 ORDER BY created_at DESC', [b.id]);
    const art = await c.query("SELECT kind, r2_key FROM artifacts WHERE book_id=$1 AND kind='docx'", [b.id]);
    b.cover_key = (cov.rows.find((r) => r.status === 'adopted') || cov.rows[0] || {}).r2_key;
    b.docx_key = (art.rows[0] || {}).r2_key;
  }
  return rows;
}

// ---- R2 ----
function r2() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  });
}
async function download(client, key, dest) {
  const r = await client.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
  const buf = Buffer.from(await r.Body.transformToByteArray());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

// ---- category path -> cascade segments ----
function segs(pathStr) {
  const p = pathStr.split('>').map((s) => s.trim());
  const i = p.findIndex((x) => x.replace(/\s/g, '') === 'Kindle本');
  return i >= 0 ? p.slice(i) : p;
}

// ---- カナ→ローマ字 (KDPのローマ字欄はASCIIのみ許可) ----
const KANA_ROMAJI = {
  'キャ':'kya','キュ':'kyu','キョ':'kyo','シャ':'sha','シュ':'shu','ショ':'sho','チャ':'cha','チュ':'chu','チョ':'cho',
  'ニャ':'nya','ニュ':'nyu','ニョ':'nyo','ヒャ':'hya','ヒュ':'hyu','ヒョ':'hyo','ミャ':'mya','ミュ':'myu','ミョ':'myo',
  'リャ':'rya','リュ':'ryu','リョ':'ryo','ギャ':'gya','ギュ':'gyu','ギョ':'gyo','ジャ':'ja','ジュ':'ju','ジョ':'jo',
  'ビャ':'bya','ビュ':'byu','ビョ':'byo','ピャ':'pya','ピュ':'pyu','ピョ':'pyo','ヂャ':'ja','ヂュ':'ju','ヂョ':'jo',
  'ヴァ':'va','ヴィ':'vi','ヴェ':'ve','ヴォ':'vo','ファ':'fa','フィ':'fi','フェ':'fe','フォ':'fo',
  'ウィ':'wi','ウェ':'we','ウォ':'wo','ティ':'ti','ディ':'di','トゥ':'tu','ドゥ':'du',
  'ア':'a','イ':'i','ウ':'u','エ':'e','オ':'o','カ':'ka','キ':'ki','ク':'ku','ケ':'ke','コ':'ko',
  'サ':'sa','シ':'shi','ス':'su','セ':'se','ソ':'so','タ':'ta','チ':'chi','ツ':'tsu','テ':'te','ト':'to',
  'ナ':'na','ニ':'ni','ヌ':'nu','ネ':'ne','ノ':'no','ハ':'ha','ヒ':'hi','フ':'fu','ヘ':'he','ホ':'ho',
  'マ':'ma','ミ':'mi','ム':'mu','メ':'me','モ':'mo','ヤ':'ya','ユ':'yu','ヨ':'yo',
  'ラ':'ra','リ':'ri','ル':'ru','レ':'re','ロ':'ro','ワ':'wa','ヲ':'o','ン':'n',
  'ガ':'ga','ギ':'gi','グ':'gu','ゲ':'ge','ゴ':'go','ザ':'za','ジ':'ji','ズ':'zu','ゼ':'ze','ゾ':'zo',
  'ダ':'da','ヂ':'ji','ヅ':'zu','デ':'de','ド':'do','バ':'ba','ビ':'bi','ブ':'bu','ベ':'be','ボ':'bo',
  'パ':'pa','ピ':'pi','プ':'pu','ペ':'pe','ポ':'po','ヴ':'vu',
  'ァ':'a','ィ':'i','ゥ':'u','ェ':'e','ォ':'o','ー':'','・':' ','　':' ',
};
function kanaToRomaji(s) {
  if (!s) return '';
  s = String(s).replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60)); // ひらがな→カタカナ
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const two = s.substr(i, 2);
    if (KANA_ROMAJI[two] !== undefined) { out += KANA_ROMAJI[two]; i++; continue; }
    const ch = s[i];
    if (ch === 'ッ') { const nx = KANA_ROMAJI[s.substr(i + 1, 2)] ?? KANA_ROMAJI[s[i + 1]] ?? ''; if (nx) out += nx[0]; continue; }
    out += KANA_ROMAJI[ch] !== undefined ? KANA_ROMAJI[ch] : ch;
  }
  return out;
}
const asciiOnly = (v) => (v && /^[\x00-\x7F]+$/.test(String(v))) ? String(v) : null;
// ローマ字欄の値: 既存romajiがASCIIならそれ、無ければカナから変換、それも無理なら未入力(undefined)
function romajiFor(romaji, kana) {
  const a = asciiOnly(romaji);
  if (a) return a;
  const r = kanaToRomaji(kana).replace(/[^\x00-\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
  return r || undefined;
}

// ---- wizard steps ----
async function fillStep1(page, b) {
  const set = async (sel, v) => { if (v == null || v === '') return; const e = await page.$(sel); if (e) await e.fill(String(v)); };
  await set('#data-title', b.title);
  await set('#data-title-pronunciation', b.title_kana);
  await set('#data-title-romanized', romajiFor(b.title_romaji, b.title_kana));
  await set('#data-subtitle', b.subtitle);
  await set('#data-subtitle-pronunciation', b.subtitle_kana);
  await set('#data-subtitle-romanized', romajiFor(b.subtitle_romaji, b.subtitle_kana));
  await set('#data-print-book-primary-author-last-name-jp', b.pen_name);
  await set('#data-primary-author-pronunciation', b.author_kana);
  await set('#data-primary-author-name-romanized', romajiFor(b.author_romaji, b.author_kana));
  for (let i = 0; i < 7; i++) if (b.keywords?.[i]) await set('#data-keywords-' + i, b.keywords[i]);
  await page.check('#non-public-domain', { force: true }).catch(() => {});
  await page.check('input[name="data[is_adult_content]-radio"][value="false"]', { force: true }).catch(() => {});
  await page.evaluate((t) => { try { if (window.CKEDITOR && CKEDITOR.instances) { const k = Object.keys(CKEDITOR.instances)[0]; if (k) CKEDITOR.instances[k].setData(t.replace(/\n/g, '<br>')); } } catch {} }, b.description || '');
  await page.waitForTimeout(2000);
  // categories
  let en = false;
  for (let i = 0; i < 15; i++) { const d = await page.getAttribute('#categories-modal-button', 'disabled').catch(() => null); if (d === null) { en = true; break; } await page.waitForTimeout(1500); }
  if (en) {
    const cats = (b.categories || []).slice(0, 3).map(segs);
    await page.click('#categories-modal-button'); await page.waitForTimeout(3500);
    const pickSelect = async (seg) => {
      for (let a = 0; a < 4; a++) {
        const info = await page.$$eval('select', (sels, seg) => sels.map((s, i) => ({ i, vis: s.offsetParent !== null, has: [...s.options].some((o) => o.textContent.trim() === seg), cur: s.options[s.selectedIndex]?.textContent.trim() })), seg);
        const t = info.find((s) => s.vis && s.has && s.cur !== seg);
        if (t) { const h = (await page.$$('select'))[t.i]; await h.selectOption({ label: seg }); await page.waitForTimeout(1600); return true; }
        await page.waitForTimeout(900);
      }
      return false;
    };
    const checkPlace = (seg) => page.evaluate((seg) => {
      const boxes = [...document.querySelectorAll('input[type=checkbox]')].filter((c) => c.offsetParent !== null);
      const lbl = (c) => { let t = ''; if (c.id) { const l = document.querySelector(`label[for="${c.id}"]`); if (l) t = l.textContent.trim(); } if (!t && c.closest('label')) t = c.closest('label').textContent.trim(); return t; };
      const ex = boxes.find((c) => lbl(c) === seg && !c.checked); const tg = ex || boxes.find((c) => !c.checked);
      if (!tg) return { ok: false }; tg.click(); return { ok: true, picked: lbl(tg), exact: !!ex };
    }, seg);
    for (let ci = 0; ci < cats.length; ci++) {
      if (ci > 0) { await page.click('button:has-text("別のカテゴリーを追加")').catch(() => {}); await page.waitForTimeout(2000); }
      let leaf = false;
      for (const seg of cats[ci]) { const ok = await pickSelect(seg); if (ok) continue; const r = await checkPlace(seg); leaf = r.ok; break; }
      if (!leaf) await checkPlace('__x__');
      await page.waitForTimeout(1200);
    }
    await page.click('button:has-text("カテゴリーを保存")').catch(() => {});
    await page.waitForTimeout(3000);
  }
  // continue
  await page.click('#save-and-continue-announce').catch(() => {});
  await page.waitForTimeout(7000);
  // detect creation-limit modal (visible)
  const limited = await page.evaluate(() => {
    const n = [...document.querySelectorAll('div,section')].find((x) => /本の作成数制限を超えました|提出可能な本の数を超え/.test(x.textContent || '') && x.offsetParent !== null && x.querySelectorAll('button,a').length <= 3);
    return !!n;
  });
  if (limited) return { blocked: 'creation_limit' };
  if (!/\/(content)/.test(page.url())) return { blocked: 'not_advanced', url: page.url() };
  return { ok: true };
}

async function fillStep2(page, coverPath, docxPath) {
  // manuscript
  await page.setInputFiles('#data-assets-interior-file-upload-AjaxInput', docxPath).catch((e) => { throw new Error('interior upload: ' + e.message); });
  log('  manuscript uploading...');
  // wait for conversion: continue enabled and no "アップロード中/変換中/処理中"
  await waitUploadDone(page, 'interior');
  // reading direction: 左から右 (横書き)
  await page.click('#a-autoid-0-announce').catch(() => {});
  // cover
  await page.setInputFiles('#data-assets-cover-file-upload-AjaxInput', coverPath).catch((e) => { throw new Error('cover upload: ' + e.message); });
  log('  cover uploading...');
  await waitUploadDone(page, 'cover');
  // AI questionnaire (truthful): text=作品全体(広範な編集あり), images=1つまたはいくつかのAI生成画像(最小限の編集あり、または編集なし), translations=なし
  await selectAqui(page, 'generative-ai-questionnaire-text', '作品全体 (広範な編集あり)');
  await selectAqui(page, 'generative-ai-questionnaire-images', '1 つまたはいくつかの AI 生成画像 (最小限の編集あり、または編集なし)');
  await selectAqui(page, 'generative-ai-questionnaire-translations', 'なし');
  await page.waitForTimeout(1500);
  await page.click('#save-and-continue-announce').catch(() => {});
  await page.waitForTimeout(7000);
  if (!/\/(pricing)/.test(page.url())) return { blocked: 'content_not_advanced', url: page.url() };
  return { ok: true };
}

async function selectAqui(page, id, label) {
  // react-aui select: set native select by label if present, else click dropdown + option
  const ok = await page.evaluate(({ id, label }) => {
    let s = document.getElementById(id);
    if (s && s.tagName !== 'SELECT') s = s.querySelector('select') || s.closest('.a-dropdown-container')?.querySelector('select');
    if (s && s.tagName === 'SELECT') {
      const opt = [...s.options].find((o) => o.textContent.trim() === label) || [...s.options].find((o) => o.textContent.trim().startsWith(label.slice(0, 8)));
      if (opt) { s.value = opt.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }
    }
    return false;
  }, { id, label });
  if (!ok) log('  WARN: AI questionnaire not set for', id);
}

// アップロード完了は「正常にアップロードしました」等の成功表示の出現で判定する
// (旧実装は「変換中/処理中」文字の消失待ちで、常駐文言により誤タイムアウトしていた)
async function waitUploadDone(page, tag, timeoutMs = 300000) {
  const successSrc =
    tag === 'interior'
      ? '正常にアップロードしました|ファイルの処理が完了|原稿チェックが完了'
      : '正常にアップロードしました|アップロードが完了';
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const err = await page.evaluate(() =>
      /アップロードに失敗|正常にアップロードできません|ファイルの処理に失敗|問題が発生しました/.test(document.body.textContent || ''),
    );
    if (err) {
      await page.screenshot({ path: path.join(STAGE, tag + '-uploaderr.png') }).catch(() => {});
      throw new Error(tag + ' upload error');
    }
    const done = await page.evaluate((src) => new RegExp(src).test(document.body.textContent || ''), successSrc);
    if (done) { await page.waitForTimeout(2500); return; }
    await page.waitForTimeout(3000);
  }
  await page.screenshot({ path: path.join(STAGE, tag + '-uploadtimeout.png') }).catch(() => {});
  throw new Error(tag + ' upload timeout');
}

async function fillStep3(page, b) {
  // territory: worldwide is default. KDP Select: keep checked (#data-is-select). royalty 70% default.
  // JP price
  await page.fill('input[name="data[digital][channels][amazon][JP][price_vat_inclusive]"]', String(b.price_jpy || 550)).catch(() => {});
  await page.waitForTimeout(2000);
  if (DRY_RUN) { log('  [dry-run] stopping before publish'); return { ok: true, dryRun: true }; }
  await page.click('#save-and-publish-announce').catch(() => {});
  await page.waitForTimeout(4000);
  // confirm dialog if any (変更内容を出版 / OK)
  await page.click('#save-and-publish-announce:visible, button:has-text("出版")').catch(() => {});
  await page.waitForTimeout(8000);
  return { ok: true };
}

async function captureAsin(page, title) {
  await page.goto(BOOKSHELF, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(5000);
  const sb = await page.$('input[type="search"], input[aria-label*="検索"], input[placeholder*="検索"]');
  if (sb) { await sb.fill(title.slice(0, 20)); await page.keyboard.press('Enter'); await page.waitForTimeout(5000); }
  const asin = await page.evaluate(() => { const m = (document.body.textContent || '').match(/\bB0[A-Z0-9]{8}\b/); return m ? m[0] : null; });
  return asin;
}

async function ensureLoggedIn(page, c) {
  await page.goto(CREATE, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000);
  if (isOnDetails(page)) return true;
  log('*** Amazonログイン処理を開始（LINE認証リレー対応）。最大10分待機します ***');
  log('    email/passwordはenv (AMAZON_EMAIL/AMAZON_PASSWORD) があれば自動入力、無ければブラウザで手入力可');
  for (let i = 0; i < 120; i++) {
    if (isOnDetails(page)) { log('ログイン確認'); return true; }

    // email 入力欄
    const emailEl = await page.$('#ap_email, input[type="email"][name="email"]').catch(() => null);
    if (emailEl && AMZ_EMAIL && (await emailEl.isVisible().catch(() => false))) {
      await emailEl.fill(AMZ_EMAIL).catch(() => {});
      await page.click('#continue, input#continue').catch(() => {});
      await page.waitForTimeout(2500);
    }

    // password 入力欄
    const passEl = await page.$('#ap_password, input[type="password"][name="password"]').catch(() => null);
    if (passEl && AMZ_PASS && (await passEl.isVisible().catch(() => false))) {
      await passEl.fill(AMZ_PASS).catch(() => {});
      await page.check('#rememberMe').catch(() => {});
      await page.click('#signInSubmit, input#signInSubmit').catch(() => {});
      await page.waitForTimeout(3000);
    }

    // OTP / 2SV / CVF 入力欄 → LINE認証リレー
    const otpEl = await page
      .$('#auth-mfa-otpcode, input[name="otpCode"], #cvf-input-code, input[name="code"]')
      .catch(() => null);
    if (otpEl && (await otpEl.isVisible().catch(() => false))) {
      const submitSel = (await page.$('#auth-signin-button').catch(() => null))
        ? '#auth-signin-button'
        : (await page.$('#cvf-submit-otp-button').catch(() => null))
          ? '#cvf-submit-otp-button'
          : 'input[type="submit"]';
      const done = await relayOtpViaLine(c, page, otpEl, submitSel);
      if (!done) return false;
    }

    // ログイン済みだが details 以外(ダッシュボード等)に着地した場合 → CREATE へ再遷移して詳細ページへ
    const url = page.url();
    if (!/signin|\/ap\/|\/mfa|\/cvf/i.test(url)) {
      const hasAuthField = await page
        .$('#ap_email, input[type="email"][name="email"], #ap_password, input[type="password"][name="password"], ' + OTP_SEL)
        .catch(() => null);
      if (!hasAuthField) {
        await page.goto(CREATE, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(6000);
        if (isOnDetails(page)) { log('ログイン確認(ウィザードへ再遷移)'); return true; }
      }
    }

    await page.waitForTimeout(5000);
  }
  return false;
}

async function main() {
  const c = db(); await c.connect();
  const books = await fetchBooks(c);
  log(`対象書籍: ${books.length}冊${DRY_RUN ? ' (DRY RUN)' : ''}`);
  if (!books.length) { await c.end(); return; }
  const s3 = r2();
  const ctx = await chromium.launchPersistentContext(USERDATA, { headless: false, channel: 'chrome', locale: 'ja-JP', viewport: { width: 1500, height: 1200 }, args: ['--disable-blink-features=AutomationControlled'] });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.setDefaultTimeout(60000);
  if (!(await ensureLoggedIn(page, c))) { log('ログイン未完了 — 中止'); await ctx.close(); await c.end(); return; }

  const results = [];
  for (const b of books) {
    log(`\n=== ${b.title} ===`);
    try {
      if (!b.cover_key || !b.docx_key) { results.push({ id: b.id, title: b.title, status: 'skip_no_assets' }); log('  資産不足 skip'); continue; }
      const coverPath = path.join(STAGE, b.id + '-cover.jpg');
      const docxPath = path.join(STAGE, b.id + '.docx');
      await download(s3, b.cover_key, coverPath);
      await download(s3, b.docx_key, docxPath);

      await page.goto(CREATE, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000);
      const s1 = await fillStep1(page, b);
      if (s1.blocked) {
        log('  BLOCKED at step1:', s1.blocked);
        await page.screenshot({ path: path.join(STAGE, b.id + '-blocked.png') }).catch(() => {});
        results.push({ id: b.id, title: b.title, status: 'blocked_' + s1.blocked });
        if (s1.blocked === 'creation_limit') { log('  作成数制限のため以降も同様と判断し中断'); break; }
        continue;
      }
      log('  step1 OK -> content');
      const s2 = await fillStep2(page, coverPath, docxPath);
      if (s2.blocked) { results.push({ id: b.id, title: b.title, status: 'blocked_' + s2.blocked }); log('  BLOCKED at step2:', s2.blocked); continue; }
      log('  step2 OK -> pricing');
      const s3r = await fillStep3(page, b);
      if (s3r.dryRun) { await page.screenshot({ path: path.join(STAGE, b.id + '-dryrun-pricing.png') }).catch(() => {}); results.push({ id: b.id, title: b.title, status: 'dry_run_ready' }); continue; }
      const asin = await captureAsin(page, b.title);
      log('  PUBLISHED asin=', asin);
      if (asin) {
        await c.query("UPDATE books SET publish_status='submitted', kdp_publish_queued=false, asin=$2 WHERE id=$1", [b.id, asin]);
      } else {
        await c.query("UPDATE books SET publish_status='submitted', kdp_publish_queued=false WHERE id=$1", [b.id]);
      }
      results.push({ id: b.id, title: b.title, status: 'published', asin });
    } catch (e) {
      log('  ERROR:', e.message);
      await page.screenshot({ path: path.join(STAGE, b.id + '-error.png') }).catch(() => {});
      results.push({ id: b.id, title: b.title, status: 'error', error: e.message });
    }
  }
  log('\n===== RESULT =====');
  for (const r of results) log(` ${r.status}\t${r.title}${r.asin ? ' ' + r.asin : ''}`);
  fs.writeFileSync(path.join(STAGE, 'result.json'), JSON.stringify(results, null, 2));
  await page.waitForTimeout(3000);
  await ctx.close();
  await c.end();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
