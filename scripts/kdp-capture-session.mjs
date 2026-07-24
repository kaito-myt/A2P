/**
 * KDP 自動取得(Phase2) — 初回セッション取得スクリプト (Enter 不要・自動保存)。
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
 *   2. 「レポート > 明細 > 月別ロイヤリティ」を開き、レポートを 1 回ダウンロード
 *      (ダウンロード動線を学習。ファイルは scripts/.kdp-captures/ に保存)。
 *   3. 済んだら **ブラウザのウィンドウを閉じる**だけ (Enter 不要)。
 *
 * セッションは数秒ごとに自動保存されるので、途中でバックグラウンド化されても、
 * プロセスが止められても、直近の状態が scripts/.kdp-session.json に残る。
 * ログインは永続プロファイル(scripts/.kdp-userdata)に保存され、次回以降は再ログイン不要。
 *
 * 出力 (すべて gitignore 済・秘密情報):
 *   scripts/.kdp-session.json   … storageState (Cookie 等)
 *   scripts/.kdp-userdata/      … 永続ブラウザプロファイル
 *   scripts/.kdp-captures/      … DL したレポート + capture-summary.json
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'scripts', '.kdp-captures');
const USER_DATA_DIR = path.join(ROOT, 'scripts', '.kdp-userdata');
const SESSION_PATH = path.join(ROOT, 'scripts', '.kdp-session.json');
const START_URL = process.env.KDP_START_URL ?? 'https://kdp.amazon.co.jp/';
const SAVE_INTERVAL_MS = 4000;
const MAX_RUNTIME_MS = 30 * 60 * 1000;

function log(...a) {
  // eslint-disable-next-line no-console
  console.log('[kdp-capture]', ...a);
}

async function loadChromium() {
  const req = createRequire(path.join(ROOT, 'apps', 'worker') + path.sep);
  const pw = await import(pathToFileURL(req.resolve('playwright')).href);
  const chromium = pw.chromium ?? pw.default?.chromium;
  if (!chromium) throw new Error('playwright の chromium をロードできませんでした');
  return chromium;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(USER_DATA_DIR, { recursive: true });
  const chromium = await loadChromium();

  log('ブラウザを起動します…');
  // 永続コンテキスト: ログインがプロファイルに残り、次回以降は再ログイン不要。
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    acceptDownloads: true,
    locale: 'ja-JP',
    viewport: null,
    args: ['--start-maximized'],
  });

  const capturedDownloads = [];
  const capturedXlsxResponses = [];
  let amazonSessionSeen = false;
  let finished = false;

  async function saveSession(reason) {
    try {
      const state = await context.storageState();
      await writeFile(SESSION_PATH, JSON.stringify(state, null, 2), 'utf-8');
      const amazonCookies = (state.cookies ?? []).filter((c) => /amazon/i.test(c.domain));
      if (!amazonSessionSeen && amazonCookies.length > 0) {
        amazonSessionSeen = true;
        log(`🔐 ログイン状態を検出しました (amazon Cookie ${amazonCookies.length} 件)。以降 ${Math.round(SAVE_INTERVAL_MS / 1000)} 秒ごとに自動保存します。`);
      }
      return { cookieCount: state.cookies?.length ?? 0, amazonCookies: amazonCookies.length };
    } catch {
      return null;
    }
  }

  async function finalize(reason) {
    if (finished) return;
    finished = true;
    const info = await saveSession(reason);
    const summary = {
      reason,
      savedSessionTo: SESSION_PATH,
      cookieCount: info?.cookieCount ?? 0,
      amazonCookies: info?.amazonCookies ?? 0,
      capturedDownloads,
      capturedXlsxResponses: capturedXlsxResponses.slice(-20),
    };
    await writeFile(path.join(OUT_DIR, 'capture-summary.json'), JSON.stringify(summary, null, 2), 'utf-8').catch(() => {});
    log('');
    log(`✅ セッションを保存しました: ${SESSION_PATH}`);
    log(`   Cookie 総数: ${summary.cookieCount} (amazon: ${summary.amazonCookies})`);
    log(`   検出したダウンロード: ${capturedDownloads.length} 件`);
    for (const d of capturedDownloads) log(`     - ${d.suggested}`);
    if (capturedDownloads.length === 0) {
      log('   ⚠ ダウンロード未検出。次回はレポートを 1 回 DL してから閉じてください。');
    }
    log('   完了です。担当(Claude)に「終わった」と伝えてください。');
    try {
      await context.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }

  function wirePage(page) {
    page.on('download', async (dl) => {
      const url = dl.url();
      const suggested = dl.suggestedFilename();
      const dest = path.join(OUT_DIR, `${Date.now()}-${suggested || 'report.bin'}`);
      try {
        await dl.saveAs(dest);
      } catch {
        /* ignore */
      }
      capturedDownloads.push({ url, suggested, savedTo: dest });
      log(`⬇ ダウンロード検出: ${suggested}`);
      await saveSession('download');
    });
    page.on('response', (res) => {
      try {
        const url = res.url();
        const ct = res.headers()['content-type'] ?? '';
        if (/\.xlsx(\?|$)/i.test(url) || /spreadsheet|officedocument|excel/i.test(ct) || /royalt|kenp|generated-reports/i.test(url)) {
          capturedXlsxResponses.push({ url, method: res.request().method(), status: res.status(), ct });
        }
      } catch {
        /* ignore */
      }
    });
  }

  context.on('page', wirePage);
  for (const p of context.pages()) wirePage(p);
  const page = context.pages()[0] ?? (await context.newPage());

  log(`サインインページを開きます: ${START_URL}`);
  await page.goto(START_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

  log('');
  log('==================================================================');
  log(' 1) 開いたブラウザで、普段どおりの方法で KDP にログインしてください。');
  log(' 2) 「レポート > 明細 > 月別ロイヤリティ」でレポートを 1 回 DL。');
  log(' 3) 済んだら ★ブラウザのウィンドウを閉じる★ だけ (Enter 不要)。');
  log('    セッションは数秒ごとに自動保存されます。');
  log('==================================================================');
  log('');

  // ブラウザを閉じたら finalize。
  context.on('close', () => void finalize('browser-closed'));
  process.on('SIGINT', () => void finalize('sigint'));
  process.on('SIGTERM', () => void finalize('sigterm'));

  // 定期自動保存。
  const timer = setInterval(() => void saveSession('interval'), SAVE_INTERVAL_MS);
  timer.unref?.();

  // 安全弁: 最大稼働時間。
  setTimeout(() => void finalize('max-runtime'), MAX_RUNTIME_MS).unref?.();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[kdp-capture] エラー:', err?.message ?? err);
  process.exit(1);
});
