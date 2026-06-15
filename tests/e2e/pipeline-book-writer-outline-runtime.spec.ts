/**
 * Runtime verification spec for T-04-04 — `pipeline.book.writer.outline` worker task
 *
 * SP-04 では Writer outline を起動する UI/API 経路はまだ配線されていないため
 * (bulkApproveOutlines SA = T-04-07 で承認 → enqueue する設計, docs/05 §5.3.3)、
 * 通常の Playwright (ブラウザ操作 → DOM 検証) では F-003 の worker 統合面を検証できない。
 * 代わりに以下を Node ランタイム上で直接呼び出して検証する:
 *
 *   1. 一時 Account + ThemeCandidate (status='accepted') + Book (theme_id 結線済) +
 *      KdpMetadata (任意) + 内部 Job (kind='pipeline.book.writer.outline',
 *      status='queued') を Prisma で投入
 *   2. `runPipelineBookWriterOutline({ payload, deps })` を直接呼出
 *      - 実 prisma + 実 generateOutline + 実 acquireBookLock / releaseBookLock +
 *        実 notifyJobChange を使う (DI なし — つまり pipeline-book-writer-outline.ts
 *        のデフォルト経路をそのまま使い、本物の book-lock + 本物の pg_notify を発火)
 *   3. 検証 (docs/05 §5.3.3 + F-003 + ADR-001):
 *      - **CAS**: 内部 Job 行が `queued` → `running` → `done` に遷移、finished_at 設定
 *      - **BookLock**: 取得 → finally で解放されて BookLock 行が 0 件
 *      - **Outline INSERT**: book_id @unique で 1 行 INSERT、status='pending_review'、
 *        chapters_json に 7-10 章、各章 index/heading/summary/target_chars/subheadings 充足
 *      - **token_usage**: 内部 Job.id 紐付けで 1 行 INSERT、role='writer',
 *        provider='anthropic', model='claude-*' (現行 ModelAssignment は sonnet)
 *      - **result_json**: { outline_id, chapters_count, total_chars_estimate,
 *        regenerated_from_rejected: false }
 *      - **子 Job 行 = なし**: bulkApproveOutlines が承認時に enqueue する設計
 *        なので、ここでは parent_job_id=<jobId> の子は 0 件であるべき
 *      - **notifyJobChange (pg_notify → SSE)**: GET /api/sse/jobs?bookId=<X> 経由で
 *        `{ jobId, status='done', kind='pipeline.book.writer.outline', bookId,
 *           phase='awaiting_outline_approval' }` を data frame で受信
 *   4. **再生成 (reject_note 注入) 検証**:
 *      - 1 回目の Outline を `status='rejected'` に更新し、新 Job を投入
 *      - 2 回目同じ book_id で `reject_note='章数を 9 にしてください'` を渡して再呼出
 *      - `result_json.regenerated_from_rejected: true` / Outline 同行 update /
 *        approved_at=null / reject_note 上書き
 *   5. クリーンアップ: token_usage / Outline / Job / KdpMetadata / BookLock /
 *      Book / ThemeCandidate / Account 全削除
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner として
 *     借用し、@a2p/db / apps/worker/.../pipeline-book-writer-outline を直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と
 *     .env.local (ANTHROPIC_API_KEY / DATABASE_URL / AUTH_*) が前提。
 *     ModelAssignment (writer, anthropic, claude-sonnet-4-6) + Prompt
 *     (role='writer', genre=null active) が seed 済であることも前提。
 *     SSE 受信検証は sse-jobs-runtime.spec.ts と同じく GET /api/sse/jobs を fetch
 *     で購読する方式 (LISTEN 自体は Next.js 側の SSE route が張る)。
 *
 * コスト: writer outline 1 呼出 ≒ $0.03-0.07 / run (~5-10 円)。
 *         再生成テストでもう 1 回呼ぶので合計 ~$0.06-0.14 (~10-20 円)。
 *         CI ではスキップ可 (PLAYWRIGHT_SKIP_REAL_API=1)
 *
 * 設計判断 (本 spec 固有):
 *  - generateOutline / acquireLock / releaseLock / notifyJobChange は **DI せず
 *    デフォルト** を使う — T-04-04 の核は「worker タスクが real LLM + real DB +
 *    real pg_notify に対して end-to-end で docs/05 §5.3.3 通り動くか」なので、
 *    本物の経路を素通しで検証する。
 *  - reject_note 再生成パスは「同 jobId 再投入」ではなく「同 book_id で別 Job 投入」
 *    を採用 — 同 Job は CAS で 'done' 状態は skip されるため、再生成シミュレーションは
 *    新 Job を作るのが現実的 (UI 側 bulkApproveOutlines も新 Job を enqueue する設計).
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { prisma } from '@a2p/db';
import { invalidateApiKeyCache } from '@a2p/agents/lib/get-api-key';
import { runPipelineBookWriterOutline, type AddJobLike } from '../../apps/worker/src/tasks/pipeline-book-writer-outline.js';

const noopAddJob: AddJobLike = async () => ({});

const SKIP_REAL_API = process.env.PLAYWRIGHT_SKIP_REAL_API === '1';
const TEST_TAG = 't-04-04-runtime-test';
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

/** storageState から `Cookie:` ヘッダ用文字列を組み立てる (sse-jobs spec と同形). */
function readCookieHeader(): string {
  const raw = readFileSync(STORAGE_STATE_PATH, 'utf8');
  const state = JSON.parse(raw) as StoredStorageState;
  return state.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * GET /api/sse/jobs?bookId=<X> を購読し、最初に到着した data frame を JSON.parse
 * して返す。タイムアウト超過時は null。
 */
async function captureFirstSseDataFrame(args: {
  baseURL: string;
  cookieHeader: string;
  bookId: string;
  /** 接続後どれだけ待つか (LLM 呼出 + DB I/O 完了まで). */
  timeoutMs: number;
  /** SSE 接続が確立されてから呼び出される。pg_notify 発火トリガー. */
  triggerAfterConnect: () => Promise<void>;
}): Promise<Record<string, unknown> | null> {
  const ac = new AbortController();
  try {
    const res = await fetch(
      `${args.baseURL}/api/sse/jobs?bookId=${encodeURIComponent(args.bookId)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Cookie: args.cookieHeader,
        },
        signal: ac.signal,
      },
    );
    if (res.status !== 200) {
      throw new Error(`SSE connect failed: HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('SSE response has no body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const start = Date.now();
    let triggered = false;

    try {
      while (Date.now() - start < args.timeoutMs) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx + 2);
          buf = buf.slice(idx + 2);
          if (frame.startsWith(': connected')) {
            // 接続確立 → trigger 発火
            if (!triggered) {
              triggered = true;
              // 順序保証のため await を待たず即時 schedule
              args.triggerAfterConnect().catch((e) => {
                // eslint-disable-next-line no-console
                console.error('[T-04-04 trigger] failed:', e);
              });
            }
            continue;
          }
          if (frame.startsWith('data: ')) {
            const jsonStr = frame.slice('data: '.length, -2);
            return JSON.parse(jsonStr) as Record<string, unknown>;
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
    return null;
  } finally {
    ac.abort();
  }
}

test.describe('runtime: pipeline.book.writer.outline worker task (T-04-04)', () => {
  // claude-sonnet-4-6 outline 1 回 + DB I/O + BookLock acquire/release + SSE 待ち
  // で 30-180s。再生成テストでもう 1 回呼ぶため合計 600s 上限。
  test.setTimeout(600_000);

  let accountId: string;
  let themeId: string;
  let bookId: string;
  let firstJobId: string;
  let secondJobId: string;
  let firstOutlineId: string;

  test.beforeAll(async () => {
    if (SKIP_REAL_API) return;
    invalidateApiKeyCache();

    // 1) 一時 Account
    const account = await prisma.account.create({
      data: {
        pen_name: `e2e-pipe-writer-outline-${Date.now()}`,
        genre_policy_json: {
          primary_genre: 'business',
          ratio: { business: 1 },
          focus_themes: ['remote_work'],
        },
        status: 'archived',
      },
    });
    accountId = account.id;

    // 2) 一時 ThemeCandidate (status='accepted')
    const theme = await prisma.themeCandidate.create({
      data: {
        account_id: accountId,
        theme_session_id: `${TEST_TAG}-session-${Date.now()}`,
        genre: 'business',
        title: 'リモートワーク時代のチームマネジメント実践ガイド',
        subtitle: '心理的安全性と成果を両立する 5 つのフレームワーク',
        hook: 'リモート/ハイブリッド環境で信頼ベースの組織を作るための実務マニュアル',
        target_reader: '中小企業〜大企業の課長・部長クラス（30〜50歳）',
        competitors_json: [
          { title: '心理的安全性のつくりかた', url: 'https://example.com/c1', asin: 'B0XEX1' },
          { title: 'リモートチームの教科書', url: 'https://example.com/c2', asin: 'B0XEX2' },
        ],
        signals_json: {
          reasoning: 'リモート定着で需要継続',
          market_score: 72,
          predicted_chapters: 8,
          search_keywords: ['リモートワーク', 'チームマネジメント'],
          search_volume: 18000,
          rank_estimate: 25000,
          sources: ['amazon_search'],
        },
        status: 'accepted',
        decided_at: new Date(),
      },
    });
    themeId = theme.id;

    // 3) 一時 Book (theme_id 結線済、status='running' = marketer 完了想定)
    const book = await prisma.book.create({
      data: {
        account_id: accountId,
        theme_id: themeId,
        title: theme.title,
        subtitle: theme.subtitle,
        status: 'running',
        prompt_version_ids_json: {},
        model_assignment_snapshot: {},
      },
    });
    bookId = book.id;

    // 4) KdpMetadata 投入 (Writer 参考情報 — 不在でも warn 継続だが、ここでは
    //    通常パス検証として有り側を投入)
    await prisma.kdpMetadata.create({
      data: {
        book_id: bookId,
        description:
          'リモートワーク時代の管理職に向けた、心理的安全性と成果を両立するチームマネジメント実践ガイド。明日から使える 5 つのフレームワークを提供する。',
        keywords: [
          'リモートワーク',
          'チームマネジメント',
          '心理的安全性',
          'ハイブリッドワーク',
          '組織開発',
        ],
        categories: ['ビジネス・経済 > マネジメント・人材管理', 'ビジネス・経済 > リーダーシップ'],
        price_jpy: 980,
      },
    });

    // 5) 内部 Job (1 回目: kind='pipeline.book.writer.outline', status='queued')
    const job = await prisma.job.create({
      data: {
        kind: 'pipeline.book.writer.outline',
        book_id: bookId,
        status: 'queued',
        payload_json: {
          source: 'e2e/pipeline-book-writer-outline-runtime.spec.ts',
          book_id: bookId,
        },
      },
    });
    firstJobId = job.id;

    // 6) 既存 BookLock 残骸を除去 (テスト独立性)
    await prisma.bookLock
      .deleteMany({ where: { book_id: bookId } })
      .catch(() => undefined);
  });

  test.afterAll(async () => {
    if (SKIP_REAL_API) return;

    // 順序: token_usage → Outline → Job → KdpMetadata → BookLock → Book → Theme → Account
    if (bookId) {
      await prisma.tokenUsage
        .deleteMany({ where: { book_id: bookId } })
        .catch(() => undefined);
      await prisma.outline
        .deleteMany({ where: { book_id: bookId } })
        .catch(() => undefined);
      await prisma.kdpMetadata
        .deleteMany({ where: { book_id: bookId } })
        .catch(() => undefined);
      await prisma.bookLock
        .deleteMany({ where: { book_id: bookId } })
        .catch(() => undefined);
      await prisma.job
        .deleteMany({ where: { book_id: bookId } })
        .catch(() => undefined);
      await prisma.book.delete({ where: { id: bookId } }).catch(() => undefined);
    }
    if (themeId) {
      await prisma.themeCandidate
        .delete({ where: { id: themeId } })
        .catch(() => undefined);
    }
    if (accountId) {
      await prisma.account
        .delete({ where: { id: accountId } })
        .catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  test('1回目: runPipelineBookWriterOutline 実行 → CAS / BookLock / Outline INSERT / token_usage / SSE notify', async ({
    baseURL,
  }) => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // 事前確認
    const initialJob = await prisma.job.findUnique({ where: { id: firstJobId } });
    expect(initialJob?.status).toBe('queued');
    expect(initialJob?.started_at).toBeNull();
    expect(initialJob?.finished_at).toBeNull();

    const initialOutline = await prisma.outline.findUnique({
      where: { book_id: bookId },
    });
    expect(initialOutline).toBeNull();

    const initialUsage = await prisma.tokenUsage.count({
      where: { job_id: firstJobId },
    });
    expect(initialUsage).toBe(0);

    const initialLocks = await prisma.bookLock.count({
      where: { book_id: bookId },
    });
    expect(initialLocks).toBe(0);

    // --- SSE 購読 + 並行実呼出 (DI なし = デフォルト経路) -----------------
    // SSE 接続が確立後 (": connected" 受信後) に runPipelineBookWriterOutline を発火し、
    // worker 内 notifyJobChange が pg_notify('jobs', ...) を呼ぶ → SSE で data frame
    // 受信。
    //
    // LLM 出力揺れ (writer.outline.invalid_output / chars_out_of_range) に備え
    // 最大 3 回 retry。失敗時は内部 Job を queued に戻して再投入する。
    const cookieHeader = readCookieHeader();

    const runWithRetry = async () => {
      const MAX_ATTEMPTS = 3;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          await runPipelineBookWriterOutline({
            book_id: bookId,
            job_id: firstJobId,
          }, noopAddJob);
          return;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.warn(
            `[T-04-04 runtime] 1st-call attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`,
          );
          const isWriterAgentError = msg.startsWith('writer.outline.');
          if (!isWriterAgentError) throw err;
          if (attempt === MAX_ATTEMPTS) break;
          await prisma.tokenUsage
            .deleteMany({ where: { job_id: firstJobId } })
            .catch(() => undefined);
          await prisma.outline
            .deleteMany({ where: { book_id: bookId } })
            .catch(() => undefined);
          await prisma.bookLock
            .deleteMany({ where: { book_id: bookId } })
            .catch(() => undefined);
          await prisma.job.update({
            where: { id: firstJobId },
            data: { status: 'queued', started_at: null, finished_at: null, error: null },
          });
        }
      }
      if (lastErr) throw lastErr;
    };

    // SSE 接続 + trigger 並行 — generateOutline は 30-90s かかるので、SSE タイムアウト
    // を 300s に設定。SSE は ": connected" 受信後に trigger を schedule する。
    const sseEvent = await captureFirstSseDataFrame({
      baseURL: baseURL ?? 'http://localhost:3001',
      cookieHeader,
      bookId,
      timeoutMs: 300_000,
      triggerAfterConnect: runWithRetry,
    });

    // SSE event 検証 (注: notify は worker 完了直前に発火するため、ここで返ってきた
    // 時点で Job は done になっているはず)
    expect(sseEvent).not.toBeNull();
    expect(sseEvent!.jobId).toBe(firstJobId);
    expect(sseEvent!.status).toBe('done');
    expect(sseEvent!.kind).toBe('pipeline.book.writer.outline');
    expect(sseEvent!.bookId).toBe(bookId);
    expect(sseEvent!.phase).toBe('awaiting_outline_approval');
    expect(typeof sseEvent!.updated_at).toBe('string');

    // --- 1) Job CAS: queued → running → done ------------------------------
    const finalJob = await prisma.job.findUnique({ where: { id: firstJobId } });
    expect(finalJob).not.toBeNull();
    expect(finalJob!.status).toBe('done');
    expect(finalJob!.started_at).not.toBeNull();
    expect(finalJob!.finished_at).not.toBeNull();
    expect(
      finalJob!.finished_at!.getTime() - finalJob!.started_at!.getTime(),
    ).toBeGreaterThanOrEqual(0);
    expect(finalJob!.error).toBeNull();

    // result_json: { outline_id, chapters_count, total_chars_estimate, regenerated_from_rejected:false }
    const resultJson = finalJob!.result_json as Record<string, unknown>;
    expect(typeof resultJson.outline_id).toBe('string');
    expect(typeof resultJson.chapters_count).toBe('number');
    expect(typeof resultJson.total_chars_estimate).toBe('number');
    expect(resultJson.regenerated_from_rejected).toBe(false);

    // --- 2) BookLock: 取得→解放されている (0 件) --------------------------
    const finalLocks = await prisma.bookLock.findMany({
      where: { book_id: bookId },
    });
    expect(finalLocks).toHaveLength(0);

    // --- 3) Outline INSERT (book_id @unique → 1 行) -----------------------
    const outline = await prisma.outline.findUnique({
      where: { book_id: bookId },
    });
    expect(outline).not.toBeNull();
    expect(outline!.book_id).toBe(bookId);
    expect(outline!.id).toBe(resultJson.outline_id);
    expect(outline!.status).toBe('pending_review');
    expect(outline!.reject_note).toBeNull();
    expect(outline!.approved_at).toBeNull();
    firstOutlineId = outline!.id;

    // chapters_json: 7-10 章、各章 index/heading/summary/target_chars/subheadings
    const chapters = outline!.chapters_json as Array<{
      index: number;
      heading: string;
      summary: string;
      target_chars: number;
      subheadings: string[];
    }>;
    expect(Array.isArray(chapters)).toBe(true);
    expect(chapters.length).toBeGreaterThanOrEqual(7);
    expect(chapters.length).toBeLessThanOrEqual(10);
    expect(chapters.length).toBe(resultJson.chapters_count);

    for (let i = 0; i < chapters.length; i += 1) {
      const c = chapters[i]!;
      expect(c.index).toBe(i + 1);
      expect(typeof c.heading).toBe('string');
      expect(c.heading.length).toBeGreaterThan(0);
      expect(typeof c.summary).toBe('string');
      expect(c.summary.length).toBeGreaterThan(0);
      expect(Number.isInteger(c.target_chars)).toBe(true);
      expect(c.target_chars).toBeGreaterThanOrEqual(2000);
      expect(c.target_chars).toBeLessThanOrEqual(15000);
      expect(Array.isArray(c.subheadings)).toBe(true);
      expect(c.subheadings.length).toBeGreaterThanOrEqual(2);
    }

    // total_chars_estimate と合計が一致
    const sum = chapters.reduce((acc, c) => acc + c.target_chars, 0);
    expect(sum).toBe(resultJson.total_chars_estimate);

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-04 outline] chapters=${chapters.length} total_chars=${sum} outline_id=${outline!.id}`,
    );

    // --- 4) token_usage: Job.id 紐付けで 1 行 ------------------------------
    const usageRows = await prisma.tokenUsage.findMany({
      where: { job_id: firstJobId },
    });
    expect(usageRows).toHaveLength(1);
    const usage = usageRows[0]!;
    expect(usage.provider).toBe('anthropic');
    expect(usage.role).toBe('writer');
    expect(usage.book_id).toBe(bookId);
    expect(usage.job_id).toBe(firstJobId);
    // ModelAssignment 経由で claude-sonnet-4-6 (将来 opus 切替に寛容に)
    expect(usage.model).toMatch(/^claude-/);
    expect(usage.input_tokens).toBeGreaterThan(100);
    expect(usage.output_tokens).toBeGreaterThan(0);
    expect(usage.image_count).toBe(0);

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-04 token_usage] model=${usage.model} input=${usage.input_tokens} ` +
        `output=${usage.output_tokens} cost_jpy=${usage.cost_jpy.toString()}`,
    );

    // --- 5) 子 Job 行 = なし (承認待ち停止) -------------------------------
    const children = await prisma.job.findMany({
      where: { parent_job_id: firstJobId },
    });
    expect(children).toHaveLength(0);
  });

  test('2回目: reject_note 注入再生成 → Outline 同行 update / approved_at=null / regenerated_from_rejected=true', async ({
    baseURL,
  }) => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // 1 回目の Outline が pending_review で存在することを確認
    const existing = await prisma.outline.findUnique({
      where: { book_id: bookId },
    });
    expect(existing).not.toBeNull();
    expect(firstOutlineId).toBeTruthy();

    // Outline を rejected 状態にする (UI 側差戻し相当)
    await prisma.outline.update({
      where: { book_id: bookId },
      data: { status: 'rejected', reject_note: '章数を 9 にしてください' },
    });

    // 2 回目の Job を新規作成 (同 jobId 再投入は CAS 弾かれるため新 Job)
    const job2 = await prisma.job.create({
      data: {
        kind: 'pipeline.book.writer.outline',
        book_id: bookId,
        status: 'queued',
        payload_json: {
          source: 'e2e/pipeline-book-writer-outline-runtime.spec.ts',
          book_id: bookId,
          reject_note: '章数を 9 にしてください',
        },
      },
    });
    secondJobId = job2.id;

    const cookieHeader = readCookieHeader();

    const runWithRetry = async () => {
      const MAX_ATTEMPTS = 3;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          await runPipelineBookWriterOutline({
            book_id: bookId,
            job_id: secondJobId,
            reject_note: '章数を 9 にしてください',
          }, noopAddJob);
          return;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.warn(
            `[T-04-04 runtime] 2nd-call attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`,
          );
          const isWriterAgentError = msg.startsWith('writer.outline.');
          if (!isWriterAgentError) throw err;
          if (attempt === MAX_ATTEMPTS) break;
          await prisma.tokenUsage
            .deleteMany({ where: { job_id: secondJobId } })
            .catch(() => undefined);
          await prisma.bookLock
            .deleteMany({ where: { book_id: bookId } })
            .catch(() => undefined);
          await prisma.job.update({
            where: { id: secondJobId },
            data: { status: 'queued', started_at: null, finished_at: null, error: null },
          });
        }
      }
      if (lastErr) throw lastErr;
    };

    const sseEvent2 = await captureFirstSseDataFrame({
      baseURL: baseURL ?? 'http://localhost:3001',
      cookieHeader,
      bookId,
      timeoutMs: 300_000,
      triggerAfterConnect: runWithRetry,
    });

    expect(sseEvent2).not.toBeNull();
    expect(sseEvent2!.jobId).toBe(secondJobId);
    expect(sseEvent2!.status).toBe('done');
    expect(sseEvent2!.kind).toBe('pipeline.book.writer.outline');
    expect(sseEvent2!.bookId).toBe(bookId);
    expect(sseEvent2!.phase).toBe('awaiting_outline_approval');

    // --- 検証: Job done / result_json.regenerated_from_rejected:true ------
    const finalJob2 = await prisma.job.findUnique({ where: { id: secondJobId } });
    expect(finalJob2!.status).toBe('done');
    const resultJson2 = finalJob2!.result_json as Record<string, unknown>;
    expect(resultJson2.regenerated_from_rejected).toBe(true);
    // 同 book_id なので outline_id は upsert で同じ行 ID が返る
    expect(resultJson2.outline_id).toBe(firstOutlineId);

    // --- Outline: 同行 update / approved_at=null / status=pending_review / reject_note 上書き
    const outline2 = await prisma.outline.findUnique({
      where: { book_id: bookId },
    });
    expect(outline2).not.toBeNull();
    expect(outline2!.id).toBe(firstOutlineId); // 同 ID (upsert)
    expect(outline2!.status).toBe('pending_review');
    expect(outline2!.approved_at).toBeNull();
    expect(outline2!.reject_note).toBe('章数を 9 にしてください');
    const chapters2 = outline2!.chapters_json as Array<{ index: number }>;
    expect(Array.isArray(chapters2)).toBe(true);
    expect(chapters2.length).toBeGreaterThanOrEqual(7);
    expect(chapters2.length).toBeLessThanOrEqual(10);

    // BookLock 解放確認
    const locks2 = await prisma.bookLock.findMany({
      where: { book_id: bookId },
    });
    expect(locks2).toHaveLength(0);

    // token_usage: 2 回目 Job.id 紐付けで 1 行追加
    const usage2 = await prisma.tokenUsage.findMany({
      where: { job_id: secondJobId },
    });
    expect(usage2).toHaveLength(1);
    expect(usage2[0]!.role).toBe('writer');

    // 子 Job 0 件 (承認待ち停止)
    const children2 = await prisma.job.findMany({
      where: { parent_job_id: secondJobId },
    });
    expect(children2).toHaveLength(0);

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-04 regen] outline_id=${outline2!.id} (same=${
        outline2!.id === firstOutlineId
      }) chapters=${chapters2.length} reject_note=${outline2!.reject_note}`,
    );
  });
});
