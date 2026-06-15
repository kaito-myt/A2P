/**
 * Runtime verification spec for T-03-11 — GET /api/sse/jobs (docs/05 §1.4 / §4.2.1 / ADR-001).
 *
 * SP-03 段階では SSE を購読する UI ページはまだ無いので、通常の Playwright
 * (ブラウザ操作 → DOM 検証) では F-024 相当の SSE 配信を検証できない。
 * 代わりに Node の fetch + ReadableStream で /api/sse/jobs を直接購読し、
 * worker の notify ヘルパ (`@a2p/worker/lib/notify-job-change`) を Prisma 経由
 * で実 PostgreSQL に対して発火させて、SSE 配信を end-to-end で確認する。
 *
 * 検証内容:
 *   1. 認証なし → 401 Unauthorized
 *   2. 認証あり + GET /api/sse/jobs
 *      - HTTP 200, Content-Type: text/event-stream
 *      - Cache-Control: no-cache, X-Accel-Buffering: no
 *      - 接続直後に ": connected" コメントが流れる
 *      - notifyJobChange({jobId, status, kind, bookId}) を発火 →
 *        SSE で `data: {...jobId...bookId...}\n\n` が届く
 *      - payload を JSON.parse して jobId/status/kind/bookId/updated_at を確認
 *   3. ?bookId=<X> フィルタ
 *      - 別 book に対する notify は SSE に流れない
 *      - 一致する book の notify のみ流れる
 *
 * クリーンアップ: 作成した一時 Book / Account / Job 行を削除
 *
 * コスト: ゼロ (LLM/外部 API 呼出なし、DB I/O と SSE のみ)
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner と
 *     して借用し、Node fetch / @a2p/db / @a2p/worker を直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433)、.env.local
 *     (DATABASE_URL / AUTH_*) と、global.setup.ts による storageState
 *     (tests/e2e/.auth/user.json) が前提。
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { prisma } from '@a2p/db';
import { notifyJobChange } from '../../apps/worker/src/lib/notify-job-change.js';

const TEST_TAG = 't-03-11-sse-runtime';
const STORAGE_STATE_PATH = path.resolve('tests/e2e/.auth/user.json');

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

interface StoredStorageState {
  cookies: StoredCookie[];
}

/** storageState から `Cookie:` ヘッダ用文字列を組み立てる. */
function readCookieHeader(): string {
  const raw = readFileSync(STORAGE_STATE_PATH, 'utf8');
  const state = JSON.parse(raw) as StoredStorageState;
  return state.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

test.describe('runtime: GET /api/sse/jobs SSE 配信 (T-03-11)', () => {
  // SSE 接続 + notify 発火 + 読み取り、フィルタ含めて 60s
  test.setTimeout(60_000);

  let accountId: string;
  let bookA: string;
  let bookB: string;
  let jobA: string;
  let jobB: string;

  test.beforeAll(async () => {
    const account = await prisma.account.create({
      data: {
        pen_name: `e2e-sse-${Date.now()}`,
        genre_policy_json: {
          primary_genre: 'business',
          ratio: { business: 1 },
          focus_themes: ['team_management'],
        },
        status: 'archived',
      },
    });
    accountId = account.id;

    const ba = await prisma.book.create({
      data: {
        account_id: accountId,
        title: `${TEST_TAG}-book-A`,
        prompt_version_ids_json: {},
        model_assignment_snapshot: {},
      },
    });
    bookA = ba.id;

    const bb = await prisma.book.create({
      data: {
        account_id: accountId,
        title: `${TEST_TAG}-book-B`,
        prompt_version_ids_json: {},
        model_assignment_snapshot: {},
      },
    });
    bookB = bb.id;

    const ja = await prisma.job.create({
      data: {
        kind: 'pipeline.book.kickoff',
        status: 'running',
        book_id: bookA,
        payload_json: { source: TEST_TAG, book_id: bookA },
      },
    });
    jobA = ja.id;

    const jb = await prisma.job.create({
      data: {
        kind: 'pipeline.book.kickoff',
        status: 'running',
        book_id: bookB,
        payload_json: { source: TEST_TAG, book_id: bookB },
      },
    });
    jobB = jb.id;
  });

  test.afterAll(async () => {
    if (jobA) await prisma.job.delete({ where: { id: jobA } }).catch(() => undefined);
    if (jobB) await prisma.job.delete({ where: { id: jobB } }).catch(() => undefined);
    if (bookA) await prisma.book.delete({ where: { id: bookA } }).catch(() => undefined);
    if (bookB) await prisma.book.delete({ where: { id: bookB } }).catch(() => undefined);
    if (accountId) await prisma.account.delete({ where: { id: accountId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // 1) 認証なし → middleware が /login へ 307 redirect (= unauth で SSE は購読不可)
  //    Route Handler 内の 401 分岐は middleware を抜けた場合の保険であり、通常
  //    middleware で先に redirect されるため、未認証アクセスは redirect で
  //    遮断されることを確認する。
  // ---------------------------------------------------------------------------
  test('認証なしで GET /api/sse/jobs → middleware が /login へ redirect (307)', async ({
    baseURL,
  }) => {
    const res = await fetch(`${baseURL}/api/sse/jobs`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      // 明示的に Cookie を渡さない
      redirect: 'manual',
    });
    expect(res.status).toBe(307);
    const loc = res.headers.get('location') ?? '';
    expect(loc).toContain('/login');
  });

  // ---------------------------------------------------------------------------
  // 2) 認証あり: HTTP 応答ヘッダ + ": connected" コメント + pg_notify→SSE 配信
  // ---------------------------------------------------------------------------
  test('認証あり: text/event-stream ヘッダ + connect + notifyJobChange → SSE data frame 受信', async ({
    baseURL,
  }) => {
    const cookieHeader = readCookieHeader();
    const ac = new AbortController();

    // SSE 接続を先に開く (purposefully no await before notify so that LISTEN is established).
    const ssePromise = (async () => {
      const res = await fetch(`${baseURL}/api/sse/jobs`, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Cookie: cookieHeader,
        },
        signal: ac.signal,
      });

      // --- HTTP 応答ヘッダ検証 ---------------------------------------------
      expect(res.status).toBe(200);
      const ct = res.headers.get('content-type') ?? '';
      expect(ct.toLowerCase()).toContain('text/event-stream');
      const cc = res.headers.get('cache-control') ?? '';
      expect(cc.toLowerCase()).toContain('no-cache');
      const xab = res.headers.get('x-accel-buffering') ?? '';
      expect(xab.toLowerCase()).toBe('no');

      if (!res.body) throw new Error('SSE response has no body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const frames: string[] = [];
      const start = Date.now();
      const timeoutMs = 15_000;

      try {
        while (Date.now() - start < timeoutMs) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx + 2);
            buf = buf.slice(idx + 2);
            frames.push(frame);
            if (frame.startsWith('data:')) {
              return { frames, dataFrame: frame };
            }
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // noop
        }
      }
      return { frames, dataFrame: null as string | null };
    })();

    // SSE 接続 (pg.connect + LISTEN) を完了させるために少し待つ.
    // ": connected" コメントが届くまで待てば LISTEN は確実に張られている.
    // ここでは notify 前に 500ms の余裕を入れる (CI 用)。
    await new Promise((r) => setTimeout(r, 500));

    // notifyJobChange を発火: 実 Prisma で SELECT pg_notify('jobs', ...) を呼ぶ.
    const notifyResult = await notifyJobChange(
      {
        jobId: jobA,
        status: 'done',
        kind: 'pipeline.book.kickoff',
        bookId: bookA,
      },
      { prisma },
    );
    expect(notifyResult.ok).toBe(true);

    // SSE 側の data frame 待ち
    const sseResult = await ssePromise;
    ac.abort(); // クリーンアップ

    // --- フレーム検証 -------------------------------------------------------
    // 先頭は接続コメント (": connected\n\n")
    expect(sseResult.frames.length).toBeGreaterThanOrEqual(1);
    expect(sseResult.frames[0]).toBe(': connected\n\n');

    expect(sseResult.dataFrame).not.toBeNull();
    const dataFrame = sseResult.dataFrame!;
    expect(dataFrame.startsWith('data: ')).toBe(true);
    expect(dataFrame.endsWith('\n\n')).toBe(true);

    // payload を JSON parse
    const jsonStr = dataFrame.slice('data: '.length, -2);
    const payload = JSON.parse(jsonStr) as Record<string, unknown>;
    expect(payload.jobId).toBe(jobA);
    expect(payload.status).toBe('done');
    expect(payload.kind).toBe('pipeline.book.kickoff');
    expect(payload.bookId).toBe(bookA);
    expect(typeof payload.updated_at).toBe('string');

    // eslint-disable-next-line no-console
    console.log(
      `[T-03-11 sse no-filter] frames=${sseResult.frames.length} jobId=${payload.jobId} bookId=${payload.bookId}`,
    );
  });

  // ---------------------------------------------------------------------------
  // 3) ?bookId=A フィルタ: book B の notify は流れず、book A の notify のみ流れる
  // ---------------------------------------------------------------------------
  test('?bookId=<A>: 別 book の notify は skip され、一致 book のみ data frame で届く', async ({
    baseURL,
  }) => {
    const cookieHeader = readCookieHeader();
    const ac = new AbortController();

    const ssePromise = (async () => {
      const res = await fetch(`${baseURL}/api/sse/jobs?bookId=${encodeURIComponent(bookA)}`, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Cookie: cookieHeader,
        },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      if (!res.body) throw new Error('SSE response has no body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const frames: string[] = [];
      const start = Date.now();
      const timeoutMs = 15_000;

      try {
        while (Date.now() - start < timeoutMs) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx + 2);
            buf = buf.slice(idx + 2);
            frames.push(frame);
            if (frame.startsWith('data:')) {
              return { frames, dataFrame: frame };
            }
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // noop
        }
      }
      return { frames, dataFrame: null as string | null };
    })();

    // LISTEN 確立を待つ
    await new Promise((r) => setTimeout(r, 500));

    // 1) book B (フィルタ不一致) で notify → SSE には流れないはず
    await notifyJobChange(
      {
        jobId: jobB,
        status: 'running',
        kind: 'pipeline.book.kickoff',
        bookId: bookB,
      },
      { prisma },
    );

    // 少し待って B が来ないことを実証してから A を発火
    await new Promise((r) => setTimeout(r, 800));

    // 2) book A (フィルタ一致) で notify → これだけが SSE に届くはず
    await notifyJobChange(
      {
        jobId: jobA,
        status: 'done',
        kind: 'pipeline.book.kickoff',
        bookId: bookA,
      },
      { prisma },
    );

    const sseResult = await ssePromise;
    ac.abort();

    expect(sseResult.dataFrame).not.toBeNull();
    const dataFrame = sseResult.dataFrame!;
    const jsonStr = dataFrame.slice('data: '.length, -2);
    const payload = JSON.parse(jsonStr) as Record<string, unknown>;

    // 最初に届いた data frame は必ず book A の方 (book B はフィルタで skip された)
    expect(payload.bookId).toBe(bookA);
    expect(payload.jobId).toBe(jobA);

    // 検証: data frame は 1 つだけ (= book B は届いていない).
    //   frames には先頭の `: connected\n\n` と、bookA の `data: ...\n\n` が含まれる.
    //   コメント (heartbeat 等) は 30 秒間隔なので 5 秒以内には現れない想定.
    const dataFrames = sseResult.frames.filter((f) => f.startsWith('data:'));
    expect(dataFrames).toHaveLength(1);
    expect(dataFrames[0]).toBe(dataFrame);

    // eslint-disable-next-line no-console
    console.log(
      `[T-03-11 sse filter] frames=${sseResult.frames.length} data_frames=${dataFrames.length} bookId=${payload.bookId}`,
    );
  });
});
