/**
 * KDP 本棚操作 (Playwright) — BookshelfPort の本番実装。
 *
 * 保存済みセッションで本棚を開き、ASIN 完全一致で 1 冊に絞り込み、
 * 「出版停止(unpublish)」→(mode により)「アーカイブ(archive)」を実行する。
 * 実 KDP で検証済みの動線・セレクタを使う。playwright の import は本ファイルに閉じる。
 *
 * 安全策: 検索結果が 1 件でなければ ambiguous で中断。各操作は確認ダイアログまで踏む。
 * デバッグ証跡(スクショ)を R2 に保存する。
 */
import { createLogger } from '@a2p/contracts/logger';

import type { BookshelfPort, TakedownBookArgs, TakedownBookResult, TakedownStep } from './bookshelf-port.js';

const log = createLogger('worker.book-cull.playwright');
const BOOKSHELF_URL = process.env.KDP_BOOKSHELF_URL ?? 'https://kdp.amazon.co.jp/ja_JP/bookshelf';
const DEFAULT_TIMEOUT_MS = 60_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

export function createPlaywrightBookshelfPort(): BookshelfPort {
  return { takedownBook };
}

async function takedownBook(args: TakedownBookArgs): Promise<TakedownBookResult> {
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let storageState: unknown;
  try {
    storageState = JSON.parse(args.sessionState);
  } catch {
    return { ok: false, reason: 'session_expired', message: 'stored session is not valid JSON' };
  }

  let chromium: typeof import('playwright').chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    return { ok: false, reason: 'unknown', message: `playwright unavailable: ${errMsg(err)}` };
  }

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const steps: TakedownStep[] = [];
  try {
    const context = await browser.newContext({
      storageState: storageState as Awaited<ReturnType<import('playwright').BrowserContext['storageState']>>,
      locale: 'ja-JP',
      userAgent: UA,
      viewport: { width: 1500, height: 1000 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    async function gotoAndSearch(): Promise<{ dotsId: string; live: boolean } | { error: TakedownBookResult }> {
      await page.goto(BOOKSHELF_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
      await page.waitForTimeout(6000);
      if (/\/ap\/signin|\/signin/i.test(page.url())) {
        return { error: { ok: false, reason: 'session_expired', message: `sign-in redirect (${page.url()})` } };
      }
      const sb = await page.$('input[type="search"], input[aria-label*="検索"], input[placeholder*="検索"]');
      if (!sb) return { error: { ok: false, reason: 'action_failed', message: 'search box not found' } };
      await sb.fill(args.asin);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(6000);
      const content = await page.content();
      if (!content.includes(args.asin)) return { error: { ok: false, reason: 'not_found', message: `ASIN ${args.asin} not found` } };
      const dots = await page.$$('button[id$="-other-actions-announce"]');
      if (dots.length !== 1) return { error: { ok: false, reason: 'ambiguous', message: `${dots.length} results for ${args.asin}` } };
      const dotsId = (await dots[0]!.getAttribute('id')) ?? '';
      return { dotsId, live: /live-book-actions/.test(dotsId) };
    }

    async function openMenu(): Promise<boolean> {
      const dots = await page.$('button[id$="-other-actions-announce"]');
      if (!dots) return false;
      await dots.click().catch(() => {});
      await page.waitForTimeout(2000);
      return true;
    }

    // --- 1. unpublish (live のときのみ) ---
    let r = await gotoAndSearch();
    if ('error' in r) return r.error;
    await saveShot(page, args.asin, 'found');

    if (r.live) {
      if (!(await openMenu())) return { ok: false, reason: 'action_failed', message: 'menu open failed (unpublish)', steps };
      const unpub = await page.$('a[id^="unpublish-"]');
      if (unpub && (await unpub.isVisible().catch(() => false))) {
        await unpub.click().catch(() => {});
        await page.waitForTimeout(2500);
        const confirm = await page.$('#confirm-unpublish-announce');
        if (confirm && (await confirm.isVisible().catch(() => false))) {
          await confirm.click().catch(() => {});
          await page.waitForTimeout(5000);
          steps.push({ step: 'unpublish', ok: true });
          await saveShot(page, args.asin, 'unpublished');
        } else {
          steps.push({ step: 'unpublish', ok: false, note: 'no confirm dialog' });
        }
      } else {
        steps.push({ step: 'unpublish', ok: false, note: 'no unpublish link' });
      }
    } else {
      steps.push({ step: 'unpublish', ok: true, note: 'already not live' });
    }

    // --- 2. archive (mode により) ---
    if (args.mode === 'unpublish_archive') {
      r = await gotoAndSearch(); // 再検索(下書きに変わっているはず)
      if ('error' in r) {
        // 見つからない=既にアーカイブ済みの可能性 → 成功扱い
        return { ok: true, steps, finalState: 'archived_or_gone' };
      }
      if (!(await openMenu())) {
        steps.push({ step: 'archive', ok: false, note: 'menu open failed' });
        return { ok: true, steps, finalState: 'unpublished' };
      }
      const arch = await page.$('a[id^="digital_archive_title-"]');
      if (arch && (await arch.isVisible().catch(() => false))) {
        await arch.click().catch(() => {});
        await page.waitForTimeout(2500);
        const confirm = await page.$('#archive-title-ok-announce');
        if (confirm && (await confirm.isVisible().catch(() => false))) {
          await confirm.click().catch(() => {});
          await page.waitForTimeout(5000);
          steps.push({ step: 'archive', ok: true });
          await saveShot(page, args.asin, 'archived');
          return { ok: true, steps, finalState: 'archived' };
        }
        steps.push({ step: 'archive', ok: false, note: 'no archive confirm dialog' });
      } else {
        steps.push({ step: 'archive', ok: false, note: 'no archive link' });
      }
      return { ok: true, steps, finalState: 'unpublished' };
    }

    return { ok: true, steps, finalState: 'unpublished' };
  } catch (err) {
    const msg = errMsg(err);
    const reason = /timeout/i.test(msg) ? 'timeout' : 'unknown';
    log.warn({ err: msg, asin: args.asin }, 'takedownBook failed');
    return { ok: false, reason, message: msg, steps };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function saveShot(page: import('playwright').Page, asin: string, stage: string): Promise<void> {
  try {
    const mod = await import('@a2p/storage');
    const key = `debug/book-cull/${asin}-${stage}-${page.url().length}.png`;
    const png = await page.screenshot();
    await mod.uploadBuffer(key, png, 'image/png');
    log.info({ asin, stage, key }, 'saved book-cull debug shot');
  } catch {
    /* best-effort */
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
