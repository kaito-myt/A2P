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
 *   node scripts/kdp-publish.mjs --assist             # 準自動: 既存の下書きをresumeして各ステップを自動入力。
 *                                                     #   「保存して続行/出版」は運営者が押す(新規作成しないので日次上限を消費しない)
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
// 準自動モード: 既存の下書きをresumeして上書き入力。各ステップの「保存して続行/出版」は運営者が押す。
const ASSIST = args.includes('--assist');
// 全自動モード: 既存の下書きをresumeし、保存/出版まで自動クリック。アップロード検証で失敗本はskip(出版しない)。
const AUTO = args.includes('--auto');
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
// 長時間のブラウザ操作中は開きっぱなしの接続がアイドルで切れる。DB 書込みはその都度
// 新規接続で行い、使い終わったら閉じる(短命接続)。ブラウザ処理をDB接続寿命に依存させない。
async function dbExec(sql, params) {
  const cc = db();
  cc.on('error', () => {}); // アイドル切断で unhandled 'error' がプロセスを落とさないように
  await cc.connect();
  try { return await cc.query(sql, params); }
  finally { await cc.end().catch(() => {}); }
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
  if (ASSIST && !AUTO) return { ok: true, assist: true }; // 入力のみ。「保存して続行」は運営者が押す
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

// STEP2 の各種ラジオ/チェックを設定する。ファイル処理完了後(再描画後)に呼ぶこと。
// DRM=いいえ(なし) / AI使用=いいえ / アクセシビリティ=すべてに代替テキスト / 再アップロード確認チェック。
// 設定できたかを boolean で返す(呼出側で検証・再試行)。
async function setStep2Options(page) {
  // 読む方向: 左から右(横書き) — react-aui のトグルを念のため再クリック
  await page.click('#a-autoid-0-announce').catch(() => {});
  await page.waitForTimeout(300);
  // AI「いいえ」は react-aui のためマウスイベント一式で。native ラジオ/チェックは .click()。
  await page.evaluate(() => {
    const all = [...document.querySelectorAll('*')];
    const q = all.find((x) => /AI ツールを使用しましたか/.test(x.textContent || '') && (x.textContent || '').length < 300);
    let root = q;
    for (let i = 0; i < 10 && root; i++) { if ([...root.querySelectorAll('*')].some((e) => e.textContent.trim() === 'いいえ')) break; root = root.parentElement; }
    root = root || document.body;
    const leaf = [...root.querySelectorAll('*')].find((e) => e.textContent.trim() === 'いいえ' && e.children.length === 0);
    const target = leaf ? (leaf.closest('label,[role=radio],.a-radio,button,a') || leaf) : null;
    if (target) ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((t) => target.dispatchEvent(new MouseEvent(t, { bubbles: true })));
  });
  await page.waitForTimeout(700);
  return await page.evaluate(() => {
    const labelOf = (inp) => {
      const l = inp.closest('label') || (inp.id && document.querySelector('label[for="' + inp.id + '"]'));
      return ((l ? l.textContent : (inp.parentElement ? inp.parentElement.textContent : '')) || '').replace(/\s+/g, ' ').trim();
    };
    const radios = [...document.querySelectorAll('input[type=radio]')];
    // DRM: 「はい。デジタル著作権管理を適用します」= はい (運営者指示)
    const drmR = radios.find((r) => /デジタル著作権管理を適用します/.test(labelOf(r)))
      || radios.find((r) => /DRM/.test(labelOf(r)) && /を適用します/.test(labelOf(r)));
    if (drmR && !drmR.checked) drmR.click();
    // アクセシビリティ: すべてに代替テキスト
    const accR = [...document.querySelectorAll('input[name="data[accessibility][image_reading]"]')]
      .find((r) => /すべてに代替テキストや詳細な説明が含まれています/.test(labelOf(r)));
    if (accR && !accR.checked) accR.click();
    // 再アップロード確認チェックは AI生成コンテンツ / アクセシビリティ の各セクションに1つずつ = 複数ある。
    // 「自分の回答が正しいこと」「新しい原稿または表紙画像」を含むチェックボックスを全て入れる。
    let confirmTotal = 0;
    for (const c of [...document.querySelectorAll('input[type=checkbox]')]) {
      let n = c, match = false;
      for (let i = 0; i < 6 && n; i++) { n = n.parentElement; if (n && /自分の回答が正しいこと|新しい原稿または表紙画像/.test(n.textContent || '')) { match = true; break; } }
      if (match) { confirmTotal++; if (!c.checked) c.click(); }
    }
    const confirmChecked = [...document.querySelectorAll('input[type=checkbox]')].filter((c) => {
      let n = c; for (let i = 0; i < 6 && n; i++) { n = n.parentElement; if (n && /自分の回答が正しいこと|新しい原稿または表紙画像/.test(n.textContent || '')) return c.checked; } return false;
    }).length;
    // AI「いいえ」判定: react-aui の選択状態(aria-checked / .a-icon-radio-active) を探す
    const aiNo = (() => {
      const all = [...document.querySelectorAll('*')];
      const q = all.find((x) => /AI ツールを使用しましたか/.test(x.textContent || '') && (x.textContent || '').length < 300);
      let root = q; for (let i = 0; i < 10 && root; i++) { if ([...root.querySelectorAll('*')].some((e) => e.textContent.trim() === 'いいえ')) break; root = root.parentElement; }
      root = root || document.body;
      const leaf = [...root.querySelectorAll('*')].find((e) => e.textContent.trim() === 'いいえ' && e.children.length === 0);
      const box = leaf ? leaf.closest('label,[role=radio],.a-radio') : null;
      if (!box) return false;
      if (box.querySelector('input[type=radio]')) return box.querySelector('input[type=radio]').checked;
      return /a-icon-radio-active/.test(box.innerHTML) || box.getAttribute('aria-checked') === 'true';
    })();
    return {
      drm: !!(drmR && drmR.checked),
      accessibility: !!(accR && accR.checked),
      confirm: confirmTotal > 0 && confirmChecked >= confirmTotal,
      confirmPresent: confirmTotal > 0,
      confirmChecked,
      confirmTotal,
      aiNo,
    };
  });
}

async function fillStep2(page, coverPath, docxPath) {
  // manuscript
  await page.setInputFiles('#data-assets-interior-file-upload-AjaxInput', docxPath).catch((e) => { throw new Error('interior upload: ' + e.message); });
  log('  manuscript uploading...');
  // wait for conversion: continue enabled and no "アップロード中/変換中/処理中"
  await waitUploadDone(page, 'interior', 1);
  // reading direction: 左から右 (横書き)
  await page.click('#a-autoid-0-announce').catch(() => {});
  // cover
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(1500);
  // 表紙: 日本語マーケットプレイス用の cover-jp が実体 (従来の cover-* は非表示ダミー)
  const coverSel = (await page.$('#data-assets-cover-jp-file-upload-AjaxInput').catch(() => null))
    ? '#data-assets-cover-jp-file-upload-AjaxInput'
    : '#data-assets-cover-file-upload-AjaxInput';
  await page.setInputFiles(coverSel, coverPath).catch((e) => { throw new Error('cover upload: ' + e.message); });
  log('  cover uploading...', coverSel);
  await waitCoverDone(page);
  // アップロード後のファイル変換処理(モーダル)が終わるまで待つ。処理中/再描画中に選択すると
  // ラジオ/チェックがリセットされて未選択のまま save→ブロックされる。処理完了後にまとめて設定する。
  {
    const pdl = Date.now() + 6 * 60 * 1000;
    while (Date.now() < pdl) {
      const busy = await page.evaluate(() => /ファイルを準備しています|原稿と表紙を処理しています/.test(document.body.textContent || ''));
      if (!busy) break;
      await page.waitForTimeout(4000);
    }
  }
  await page.waitForTimeout(2000);
  // 各種ラジオ/チェックを設定 (処理完了後の再描画後)。native input は click、AI は react-aui。
  let opt = await setStep2Options(page);
  log('  step2 options:', JSON.stringify(opt));
  // 未設定(AI/DRM、または存在する確認チェック)が残っていれば数回まで再設定を試みる。
  for (let r = 0; r < 3 && (!opt.aiNo || !opt.drm || (opt.confirmPresent && !opt.confirm)); r++) {
    await page.waitForTimeout(2500);
    opt = await setStep2Options(page);
    log('  step2 options(retry ' + (r + 1) + '):', JSON.stringify(opt));
  }
  await page.waitForTimeout(800);
  // 設定後の状態を全ページスクショで残す(運営者/assistantが目視検証できるように)。
  await page.screenshot({ path: path.join(STAGE, 'step2-ready.png'), fullPage: true }).catch(() => {});
  if (ASSIST && !AUTO) return { ok: true, assist: true }; // 入力のみ。「保存して続行」は運営者が押す
  // 変換処理中(ブロッキングモーダル表示中)は保存しても /pricing に進めない。モーダルが無い時だけ
  // save-and-continue をクリックし、/pricing 到達まで一定間隔でポーリング(最大8分)。
  // ※ 残留しがちな inline「ファイルを処理しています…」ではなく、確実に前進を阻む
  //   「ファイルを準備しています/原稿と表紙を処理しています」モーダルのみを busy 判定に使う。
  const saveDeadline = Date.now() + 8 * 60 * 1000;
  let clicks = 0;
  while (Date.now() < saveDeadline) {
    const busy = await page.evaluate(() =>
      /ファイルを準備しています|原稿と表紙を処理しています/.test(document.body.textContent || ''),
    );
    if (!busy) {
      await page.click('#save-and-continue-announce').catch(() => {});
      clicks++;
      await page.waitForTimeout(6000);
      if (/\/(pricing)/.test(page.url())) return { ok: true };
    }
    await page.waitForTimeout(6000);
  }
  log('  step2 保存タイムアウト(clicks=' + clicks + ')');
  await page.screenshot({ path: path.join(STAGE, 'step2-blocked.png'), fullPage: true }).catch(() => {});
  return { blocked: 'content_not_advanced', url: page.url() };
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
// 「◯◯を正常にアップロードしました」の出現件数で判定する。
// interior 後は 1 件、cover 後は 2 件 (本文の成功文言を表紙判定で誤検知しないため)。
async function waitUploadDone(page, tag, minCount = 1, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const err = await page.evaluate(() =>
      /アップロードに失敗|正常にアップロードできません|ファイルの処理に失敗|問題が発生しました/.test(document.body.textContent || ''),
    );
    if (err) {
      await page.screenshot({ path: path.join(STAGE, tag + '-uploaderr.png') }).catch(() => {});
      throw new Error(tag + ' upload error');
    }
    const n = await page.evaluate(() => (document.body.textContent.match(/正常にアップロードしました/g) || []).length);
    if (n >= minCount) { await page.waitForTimeout(2500); return; }
    await page.waitForTimeout(3000);
  }
  await page.screenshot({ path: path.join(STAGE, tag + '-uploadtimeout.png') }).catch(() => {});
  throw new Error(tag + ' upload timeout (count<' + minCount + ')');
}

// 表紙は「表紙がアップロードされていません」プレースホルダの消失で完了判定する。
async function waitCoverDone(page, timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await page.evaluate(() => ({
      done: /表紙のアップロードに成功|アップロードに成功しました/.test(document.body.textContent || ''),
      err: /アップロードに失敗|正常にアップロードできませんでした|サポートされていないファイル|画像のサイズが小さ/.test(document.body.textContent || ''),
    }));
    if (st.err) { await page.screenshot({ path: path.join(STAGE, 'cover-err.png'), fullPage: true }).catch(() => {}); throw new Error('cover upload error'); }
    if (st.done) { await page.waitForTimeout(2500); return; }
    await page.waitForTimeout(3000);
  }
  await page.screenshot({ path: path.join(STAGE, 'cover-timeout.png'), fullPage: true }).catch(() => {});
  const txt = await page.evaluate(() => {
    const s = [...document.querySelectorAll('*')].find((x) => /Kindle 本の表紙|表紙ファイル/.test(x.textContent || '') && (x.textContent || '').length < 400);
    return s ? s.textContent.replace(/\s+/g, ' ').trim().slice(0, 250) : '(cover section not found)';
  });
  throw new Error('cover upload timeout | coverSection="' + txt + '"');
}

// アップロード後の「ファイル変換処理」完了を待つ。KDP は原稿/表紙のアップロード受信直後に
// 「正常にアップロードしました」を出すが、その後「ファイルを準備しています / 原稿と表紙を処理
// しています」モーダルで変換処理を続ける。処理中に「保存して続行」を押すとブロックされ /pricing
// へ進めない。このモーダル(処理中表示)が消えるまで待つ。
async function waitFileProcessing(page, timeoutMs = 240000) {
  const start = Date.now();
  let seen = false;
  while (Date.now() - start < timeoutMs) {
    const processing = await page.evaluate(() =>
      /ファイルを準備しています|原稿と表紙を処理しています|ファイルを処理しています/.test(document.body.textContent || ''),
    );
    if (processing) { seen = true; await page.waitForTimeout(3000); continue; }
    // 処理表示が消えた(または最初から無い)。安定確認のため少し待って再確認。
    await page.waitForTimeout(2500);
    const still = await page.evaluate(() =>
      /ファイルを準備しています|原稿と表紙を処理しています|ファイルを処理しています/.test(document.body.textContent || ''),
    );
    if (!still) return { processed: seen };
  }
  await page.screenshot({ path: path.join(STAGE, 'file-processing-timeout.png'), fullPage: true }).catch(() => {});
  return { processed: seen, timeout: true };
}

async function fillStep3(page, b) {
  // territory: worldwide is default. KDP Select: keep checked (#data-is-select). royalty 70% default.
  // JP price
  await page.fill('input[name="data[digital][channels][amazon][JP][price_vat_inclusive]"]', String(b.price_jpy || 550)).catch(() => {});
  await page.waitForTimeout(2000);
  if (ASSIST && !AUTO) return { ok: true, assist: true }; // 価格入力のみ。「出版」は運営者が押す
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
  // ASSIST時はCREATE(新規作成=下書き発生/制限)を避け、本棚でログイン判定する
  const target = (ASSIST || AUTO) ? BOOKSHELF : CREATE;
  const loggedIn = () => ((ASSIST || AUTO) ? /\/bookshelf/.test(page.url()) && !/signin/i.test(page.url()) : isOnDetails(page));
  await page.goto(target, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000);
  if (loggedIn()) return true;
  log('*** Amazonログイン処理を開始（LINE認証リレー対応）。最大10分待機します ***');
  log('    email/passwordはenv (AMAZON_EMAIL/AMAZON_PASSWORD) があれば自動入力、無ければブラウザで手入力可');
  for (let i = 0; i < 120; i++) {
    if (loggedIn()) { log('ログイン確認'); return true; }

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
        await page.goto(target, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(6000);
        if (loggedIn()) { log('ログイン確認(再遷移)'); return true; }
      }
    }

    await page.waitForTimeout(5000);
  }
  return false;
}

// 下書き編集ページ等に入る瞬間、max_auth_age=0 で再認証(パスワード/OTP)を求められることがある。
// 本棚閲覧は通るが編集ページで再認証ウォールに当たる。パスワードは概ね事前入力済みなので
// サインインをクリック、OTP は LINE リレーで通す。通過したら true。
async function passReauthIfNeeded(page, c) {
  const authForm = async () =>
    page.$('#ap_password, input[type="password"][name="password"], #signInSubmit, ' + OTP_SEL).catch(() => null);
  if (!(await authForm())) return true; // 認証フォームが無ければ通過済み
  // 注意: Chrome は自動入力パスワードをスクリプト送信から保護するため、AMAZON_PASSWORD が env に
  // 無いとスクリプトからの submit は弾かれる。その場合は運営者が「サインイン」を1回押すのを待つ。
  log('  🔐 再認証(reauth)要求。ブラウザの Amazon サインイン画面で「サインイン」を1回押してください');
  log('     (AMAZON_PASSWORD が env にあれば自動。OTPが出たら LINE に通知が飛びます)');
  let autoTries = 0;
  for (let i = 0; i < 200; i++) { // 約10分待つ
    // email (稀に要求)
    const emailEl = await page.$('#ap_email, input[type="email"][name="email"]').catch(() => null);
    if (emailEl && AMZ_EMAIL && (await emailEl.isVisible().catch(() => false))) {
      await emailEl.fill(AMZ_EMAIL).catch(() => {});
      await page.click('#continue, input#continue').catch(() => {});
      await page.waitForTimeout(2500);
    }
    // OTP → LINE リレー
    const otpEl = await page.$(OTP_SEL).catch(() => null);
    if (otpEl && (await otpEl.isVisible().catch(() => false))) {
      const submitSel = (await page.$('#auth-signin-button').catch(() => null))
        ? '#auth-signin-button'
        : (await page.$('#cvf-submit-otp-button').catch(() => null))
          ? '#cvf-submit-otp-button'
          : 'input[type="submit"]';
      const done = await relayOtpViaLine(c, page, otpEl, submitSel);
      if (!done) return false;
    }
    // password: env に AMAZON_PASSWORD があれば実タイプ+submit を最大3回自動試行。
    // 無ければ自動submitは不可(Chrome保護)なので運営者のクリックを待つ(何もしない)。
    const passEl = await page.$('#ap_password, input[type="password"][name="password"]').catch(() => null);
    if (passEl && (await passEl.isVisible().catch(() => false)) && AMZ_PASS && autoTries < 3) {
      autoTries++;
      await passEl.click().catch(() => {});
      await passEl.fill('').catch(() => {});
      await passEl.type(AMZ_PASS, { delay: 25 }).catch(() => {});
      await page.check('#auth-remember-me, #rememberMe').catch(() => {});
      await page.click('#signInSubmit, input#signInSubmit').catch(() => {});
      await page.waitForTimeout(4000);
    }
    if (!(await authForm())) { await page.waitForTimeout(1500); return true; } // 認証フォームが消えた=通過
    await page.waitForTimeout(3000);
  }
  return false;
}

// URLが正規表現にマッチするまで待つ / マッチしなくなるまで待つ
async function waitUrl(page, re, ms = 600000) { const s = Date.now(); while (Date.now() - s < ms) { if (re.test(page.url())) return true; await page.waitForTimeout(1500); } return false; }

// 本棚から「下書き」行の編集ID一覧を収集 (公開済みの本を誤って上書きしないよう下書きに限定)
async function collectDraftIds(page) {
  await page.goto(BOOKSHELF, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000);
  return page.evaluate(() => {
    const out = []; const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="editkindledetails"]')) {
      const m = (a.getAttribute('href') || '').match(/kindle\/([A-Z0-9]{8,})\/details/);
      if (!m) continue;
      let row = a;
      for (let i = 0; i < 8 && row; i++) { row = row.parentElement; if (row && /下書き/.test(row.textContent || '')) break; }
      const rt = row ? row.textContent || '' : '';
      if (/下書き/.test(rt) && !/レビュー中|販売中|ライブ|出版準備中/.test(rt) && !seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
    }
    return out;
  });
}

// 準自動モード: 既存の下書きをresumeして各ステップを自動入力。次へ/出版は運営者が押す。
async function runAssist(c, page, s3, books) {
  const editBase = 'https://kdp.amazon.co.jp/action/dualbookshelf.editkindledetails/ja_JP/title-setup/kindle/';
  const ids = await collectDraftIds(page);
  log(`下書きスロット ${ids.length}個 / 対象書籍 ${books.length}冊 → ${Math.min(ids.length, books.length)}冊を処理`);
  if (!ids.length) { log('下書きが見つかりません。中止'); return; }
  const results = [];
  const n = Math.min(ids.length, books.length);
  for (let i = 0; i < n; i++) {
    const b = books[i]; const id = ids[i];
    log(`\n=== [${i + 1}/${n}] ${b.title}  (下書き ${id}) ===`);
    try {
      if (!b.cover_key || !b.docx_key) { log('  資産不足 skip'); results.push({ title: b.title, status: 'skip_no_assets' }); continue; }
      const coverPath = path.join(STAGE, b.id + '-cover.jpg');
      const docxPath = path.join(STAGE, b.id + '.docx');
      await download(s3, b.cover_key, coverPath);
      await download(s3, b.docx_key, docxPath);
      // STEP1 (詳細) — 入力のみ
      await page.goto(editBase + id + '/details', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000);
      const titleReady = await page.waitForSelector('#data-title', { state: 'visible', timeout: 45000 }).then(() => true).catch(() => false);
      if (!titleReady) { await page.screenshot({ path: path.join(STAGE, b.id + '-nodetails.png'), fullPage: true }).catch(() => {}); log('  詳細ページの入力欄が出ません skip'); results.push({ title: b.title, status: 'no_details' }); continue; }
      await fillStep1(page, b);
      log('  ★ STEP1入力完了 → 内容を確認して「保存して続行」を押してください');
      // ページ状態ポーラ: 直線的な waitUrl は「保存して続行」後の遷移を取りこぼすと固着する。
      // 現在URLを常時監視し、content/pricing に来たらそのページを自動入力、bookshelf 復帰で完了。
      // 押すタイミング/順序に依存せず進む。現在ページを都度ログ出力し詰まり位置を可視化する。
      const filled = { content: false, pricing: false };
      const deadline = Date.now() + 45 * 60 * 1000; // 45分/冊
      let lastUrl = ''; let done = false;
      while (Date.now() < deadline) {
        const u = page.url();
        if (u !== lastUrl) { lastUrl = u; log('   … 現在ページ: ' + u.replace(/^https?:\/\/kdp\.amazon\.co\.jp/, '')); }
        if (/\/bookshelf/.test(u)) { done = true; break; }
        try {
          if (/\/content/.test(u) && !filled.content) {
            await page.waitForTimeout(2500);
            if (/\/content/.test(page.url())) { // 入力直前に再確認
              await fillStep2(page, coverPath, docxPath);
              filled.content = true;
              log('  ★ STEP2入力完了 → 「保存して続行」を押してください');
            }
          } else if (/\/pricing/.test(u) && !filled.pricing) {
            await page.waitForTimeout(2500);
            if (/\/pricing/.test(page.url())) {
              await fillStep3(page, b);
              filled.pricing = true;
              log('  ★ 価格入力完了 → 「出版」を押してください');
            }
          }
        } catch (e) {
          log('   (入力中エラー: ' + e.message + ' — 次周回で再試行)');
        }
        await page.waitForTimeout(2000);
      }
      if (!done) { log('  タイムアウト（45分）skip'); results.push({ title: b.title, status: 'timeout' }); continue; }
      await page.waitForTimeout(3000);
      await c.query("UPDATE books SET publish_status='submitted', kdp_publish_queued=false WHERE id=$1", [b.id]);
      log('  ✅ 出版検知 → publish_status=submitted');
      results.push({ title: b.title, status: 'submitted' });
    } catch (e) {
      log('  ERROR:', e.message);
      await page.screenshot({ path: path.join(STAGE, b.id + '-assist-error.png'), fullPage: true }).catch(() => {});
      results.push({ title: b.title, status: 'error', error: e.message });
    }
  }
  log('\n===== ASSIST RESULT =====');
  for (const r of results) log(` ${r.status}\t${r.title}`);
}

// 全自動: 既存の下書きをresumeし、STEP1→2→3を fill 関数の自動クリックで進め出版まで行う。
// 各ステップは検証付き(fillStep1: /content 到達 / fillStep2: アップロード成功待ち+/pricing 到達 /
// fillStep3: 出版クリック)。検証に失敗した本は throw/blocked で skip し「出版しない」= 誤資産出版を防ぐ。
async function runAuto(c, page, s3, books) {
  const editBase = 'https://kdp.amazon.co.jp/action/dualbookshelf.editkindledetails/ja_JP/title-setup/kindle/';
  const ids = await collectDraftIds(page);
  const n = Math.min(ids.length, books.length);
  log(`下書きスロット ${ids.length}個 / 対象書籍 ${books.length}冊 → ${n}冊を全自動出版`);
  if (!ids.length) { log('下書きが見つかりません。中止'); return; }
  const results = [];
  for (let i = 0; i < n; i++) {
    const b = books[i]; const id = ids[i];
    log(`\n=== [${i + 1}/${n}] ${b.title}  (下書き ${id}) ===`);
    try {
      if (!b.cover_key || !b.docx_key) { log('  資産不足 skip'); results.push({ title: b.title, status: 'skip_no_assets' }); continue; }
      const coverPath = path.join(STAGE, b.id + '-cover.jpg');
      const docxPath = path.join(STAGE, b.id + '.docx');
      await download(s3, b.cover_key, coverPath);
      await download(s3, b.docx_key, docxPath);
      await page.goto(editBase + id + '/details', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000);
      // 編集ページで再認証ウォール(max_auth_age=0)に当たることがある → 通す。
      if (!(await passReauthIfNeeded(page, c))) { log('  再認証に失敗 skip'); results.push({ title: b.title, status: 'reauth_failed' }); continue; }
      // 再認証後は詳細ページに戻っていないことがあるので、詳細ページを確実に開き直す。
      if (!/\/details/.test(page.url()) || !(await page.$('#data-title').catch(() => null))) {
        await page.goto(editBase + id + '/details', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000);
        await passReauthIfNeeded(page, c);
      }
      const titleReady = await page.waitForSelector('#data-title', { state: 'visible', timeout: 45000 }).then(() => true).catch(() => false);
      if (!titleReady) { await page.screenshot({ path: path.join(STAGE, b.id + '-nodetails.png'), fullPage: true }).catch(() => {}); log('  詳細ページ入力欄なし skip'); results.push({ title: b.title, status: 'no_details' }); continue; }
      const s1 = await fillStep1(page, b);
      if (s1.blocked) { log('  BLOCKED step1:', s1.blocked); await page.screenshot({ path: path.join(STAGE, b.id + '-blocked1.png'), fullPage: true }).catch(() => {}); results.push({ title: b.title, status: 'blocked_' + s1.blocked }); continue; }
      log('  step1 OK -> content');
      const s2 = await fillStep2(page, coverPath, docxPath); // アップロード失敗時は throw → catch で skip(出版しない)
      if (s2.blocked) { log('  BLOCKED step2:', s2.blocked); results.push({ title: b.title, status: 'blocked_' + s2.blocked }); continue; }
      log('  step2 OK (本文/表紙アップロード検証済) -> pricing');
      const s3r = await fillStep3(page, b);
      if (s3r.dryRun) { await page.screenshot({ path: path.join(STAGE, b.id + '-dryrun-pricing.png'), fullPage: true }).catch(() => {}); results.push({ title: b.title, status: 'dry_run_ready' }); continue; }
      // 出版確定: 本棚への遷移を検証。未検知なら submitted にしない(要手動確認)。
      const pub = await waitUrl(page, /bookshelf/, 120000);
      if (!pub) { log('  出版後の本棚遷移を検知できず → submittedにしない'); await page.screenshot({ path: path.join(STAGE, b.id + '-publish-unconfirmed.png'), fullPage: true }).catch(() => {}); results.push({ title: b.title, status: 'publish_unconfirmed', url: page.url() }); continue; }
      await page.waitForTimeout(3000);
      const asin = await captureAsin(page, b.title).catch(() => null);
      await dbExec("UPDATE books SET publish_status='submitted', kdp_publish_queued=false, asin=COALESCE($2,asin) WHERE id=$1", [b.id, asin]);
      log('  ✅ PUBLISHED asin=', asin, '-> publish_status=submitted');
      results.push({ title: b.title, status: 'submitted', asin });
    } catch (e) {
      log('  ERROR:', e.message);
      await page.screenshot({ path: path.join(STAGE, b.id + '-auto-error.png'), fullPage: true }).catch(() => {});
      results.push({ title: b.title, status: 'error', error: e.message });
    }
  }
  log('\n===== AUTO RESULT =====');
  for (const r of results) log(` ${r.status}\t${r.title}${r.asin ? ' ' + r.asin : ''}`);
}

async function main() {
  const c = db();
  c.on('error', (e) => { try { log('  (DB接続エラー(無視): ' + e.message + ')'); } catch {} }); // アイドル切断でプロセスを落とさない
  await c.connect();
  const books = await fetchBooks(c);
  log(`対象書籍: ${books.length}冊${DRY_RUN ? ' (DRY RUN)' : ''}${AUTO ? ' (AUTO)' : ASSIST ? ' (ASSIST)' : ''}`);
  if (!books.length) { await c.end(); return; }
  const s3 = r2();
  const ctx = await chromium.launchPersistentContext(USERDATA, { headless: false, channel: 'chrome', locale: 'ja-JP', viewport: { width: 1500, height: 1200 }, args: ['--disable-blink-features=AutomationControlled'] });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.setDefaultTimeout(60000);
  if (!(await ensureLoggedIn(page, c))) { log('ログイン未完了 — 中止'); await ctx.close(); await c.end(); return; }

  if (AUTO) { await runAuto(c, page, s3, books); await page.waitForTimeout(2000); await ctx.close(); await c.end(); return; }
  if (ASSIST) { await runAssist(c, page, s3, books); await page.waitForTimeout(2000); await ctx.close(); await c.end(); return; }

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
