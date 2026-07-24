/**
 * KDP 自動取得(Phase2) — 初回セッション取得スクリプト。
 *
 * セッション再利用方式: 運営者が一度だけ手動で Amazon/KDP にログインし、その
 * ログイン済み状態(Cookie 等 = Playwright storageState)を保存する。以降はワーカーが
 * これを再利用してレポートをダウンロードするため、bot 検知/2FA をほぼ回避できる。
 *
 * 使い方 (運営者のローカル PC で 1 回だけ実行):
 *   ! node scripts/kdp-capture-session.mjs
 *
 * 手順:
 *   1. 実ブラウザ(ヘッドフル)が開くので、普段どおりの方法(Google 経由でも)でログイン。
 *   2. 「レポート > 明細 > 月別ロイヤリティ」を開き、レポートを **1 回ダウンロード**する
 *      (ダウンロード動線の URL を学習するため。ファイルは scripts/.kdp-captures/ に保存)。
 *   3. ログイン＆DL確認が済んだら、ターミナルで **Enter** を押す。
 *   4. ログイン済みセッションが scripts/.kdp-session.json に保存される
 *      (このファイルは秘密情報。gitignore 済み。中身は担当(Claude)が暗号化して本番に保存)。
 *
 * 注意: このファイルは秘密情報を出力しない。storage+DL は scripts/.kdp-* に保存する。
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'scripts', '.kdp-captures');
const SESSION_PATH = path.join(ROOT, 'scripts', '.kdp-session.json');
const START_URL = process.env.KDP_START_URL ?? 'https://kdp.amazon.co.jp/';

function log(...a) {
  // eslint-disable-next-line no-console
  console.log('[kdp-capture]', ...a);
}

async function loadChromium() {
  // playwright を worker の依存解決経由でロード (root .pnpm 実体)。
  const req = createRequire(path.join(ROOT, 'apps', 'worker') + path.sep);
  const pwPath = req.resolve('playwright');
  const pw = await import(pathToFileURL(pwPath).href);
  return pw.chromium;
}

function waitForEnter(promptText) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const chromium = await loadChromium();

  log('ブラウザを起動します…');
  const browser = await chromium.launch({ headless: false, args: ['--start-maximized'] });
  const context = await browser.newContext({
    locale: 'ja-JP',
    viewport: null,
    acceptDownloads: true,
  });

  const capturedDownloads = [];
  const capturedXlsxResponses = [];

  function wirePage(page) {
    page.on('download', async (dl) => {
      const url = dl.url();
      const suggested = dl.suggestedFilename();
      const dest = path.join(OUT_DIR, `${Date.now()}-${suggested || 'report.bin'}`);
      try {
        await dl.saveAs(dest);
      } catch {
        /* ignore save errors */
      }
      capturedDownloads.push({ url, suggested, savedTo: dest });
      log(`⬇ ダウンロード検出: ${suggested} ← ${url}`);
      log(`  保存先: ${dest}`);
    });
    page.on('response', async (res) => {
      try {
        const url = res.url();
        const ct = res.headers()['content-type'] ?? '';
        if (
          /\.xlsx(\?|$)/i.test(url) ||
          /spreadsheet|officedocument|excel|vnd\.ms-excel/i.test(ct) ||
          /royalt|kenp|report/i.test(url)
        ) {
          capturedXlsxResponses.push({ url, method: res.request().method(), status: res.status(), ct });
        }
      } catch {
        /* ignore */
      }
    });
  }

  context.on('page', wirePage);
  const page = await context.newPage();
  wirePage(page);

  log(`サインインページを開きます: ${START_URL}`);
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  log('');
  log('==================================================================');
  log(' 1) 開いたブラウザで、普段どおりの方法で KDP にログインしてください。');
  log(' 2) 「レポート > 明細 > 月別ロイヤリティ」を開き、対象月を選んで');
  log('    レポートを 1 回ダウンロードしてください（DL 動線を学習します）。');
  log(' 3) 済んだら、このターミナルで Enter を押してください。');
  log('==================================================================');
  log('');

  await waitForEnter('ログイン & レポートDLが済んだら Enter を押してください… ');

  // ログイン済みセッションを保存。
  const state = await context.storageState();
  await writeFile(SESSION_PATH, JSON.stringify(state, null, 2), 'utf-8');

  const summary = {
    savedSessionTo: SESSION_PATH,
    cookieCount: state.cookies?.length ?? 0,
    amazonCookies: (state.cookies ?? []).filter((c) => /amazon/i.test(c.domain)).length,
    capturedDownloads,
    capturedXlsxResponses: capturedXlsxResponses.slice(-20),
  };
  await writeFile(path.join(OUT_DIR, 'capture-summary.json'), JSON.stringify(summary, null, 2), 'utf-8');

  log('');
  log(`✅ セッションを保存しました: ${SESSION_PATH}`);
  log(`   Cookie 総数: ${summary.cookieCount} (amazon: ${summary.amazonCookies})`);
  log(`   検出したダウンロード: ${capturedDownloads.length} 件`);
  if (capturedDownloads.length > 0) {
    for (const d of capturedDownloads) log(`     - ${d.suggested} (${d.savedTo})`);
  } else {
    log('   ⚠ ダウンロードが検出されませんでした。レポートを 1 回 DL してから Enter してください。');
  }
  log(`   サマリ: ${path.join(OUT_DIR, 'capture-summary.json')}`);
  log('');
  log('この後、担当(Claude)が .kdp-session.json を暗号化して本番DBに保存し、');
  log('ワーカーの自動取得を有効化します。ブラウザは閉じて構いません。');

  await browser.close().catch(() => {});
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[kdp-capture] エラー:', err?.message ?? err);
  process.exit(1);
});
