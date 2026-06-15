/**
 * Runtime verification spec for T-03-04 — `pipeline.book.marketer` worker タスク
 *
 * SP-03 段階で SP-04 以降の UI/API パイプ起点 (S-018 自動化計画 → kickoff) はまだ
 * 配線されていないため、通常の Playwright (ブラウザ操作 → DOM 検証) では F-001/F-040
 * の worker 統合面を検証できない。代わりに以下を Node ランタイム上で直接呼び出して
 * 検証する:
 *
 *   1. 一時 Account + ThemeCandidate (status='accepted') + Book (theme_id 結線済) +
 *      内部 Job (kind='pipeline.book.marketer', status='queued') を Prisma で投入
 *   2. `runPipelineBookMarketer({ book_id, job_id }, addJob, deps)` を直接呼出
 *      - addJob は spy にして子 enqueue ペイロードを観測する
 *      - generateMetadata / acquireLock / releaseLock は DI せずデフォルト
 *        (= 実 LLM + 実 BookLock) を使う
 *   3. 検証:
 *      - **CAS**: 内部 Job 行が `queued` → `running` → `done` に遷移、finished_at 設定
 *      - **BookLock**: 取得 → 解放されて BookLock 行が 0 件
 *      - **KdpMetadata**: book_id @unique で 1 行 INSERT、description/keywords/
 *        categories/price_jpy が F-040 制約 (description 50〜4000 / keywords 1〜7 /
 *        categories.length=2 / price_jpy>=99) を満たす
 *      - **token_usage**: 内部 Job.id 紐付けで 1 行 INSERT、role='marketer',
 *        provider='anthropic', model='claude-opus-4-7'
 *      - **子 Job 行**: parent_job_id=<marketer jobId> + kind='pipeline.book.writer.outline'
 *        + status='queued' で 1 行 INSERT
 *      - **addJob 呼出**: identifier='pipeline.book.writer.outline', payload に
 *        book_id + 子 Job.id (NOT marketer jobId)
 *   4. クリーンアップ: KdpMetadata / TokenUsage / 子 Job / 親 Job / Book /
 *      ThemeCandidate / Account / BookLock を deleteMany
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner
 *     として借用し、@a2p/db / apps/worker/.../pipeline-book-marketer を直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と
 *     .env.local (ANTHROPIC_API_KEY 実値あり) が前提。
 *     ModelAssignment (marketer, anthropic, claude-opus-4-7) + Prompt
 *     (role='marketer', genre=null active) が seed 済であることも前提。
 *
 * コスト: claude-opus-4-7 metadata 1 呼出 ≒ $0.05-0.10 / run (~7-15 円)
 *         CI ではスキップ可 (PLAYWRIGHT_SKIP_REAL_API=1)
 *
 * 設計判断 (本 spec 固有):
 *  - generateMetadata / acquireLock / releaseLock は **DI せず本物を使う** —
 *    T-03-04 の核は「worker タスクが real LLM + real DB に対して end-to-end で
 *    docs/05 §5.3.2 通り動くか」なので、本物の `book-lock.ts` と本物の
 *    `generateMarketerMetadata` を素通しで検証する。
 *  - graphile-worker.workerUtils.addJob 経由ではなく `runPipelineBookMarketer` を
 *    直接呼ぶ — graphile-worker runner 起動を E2E で立てるのは複雑で、子 enqueue
 *    観測も困難。addJob 引数は spy で十分検証できる。
 *  - 子 Job の `kind='pipeline.book.writer.outline'` 行 INSERT は schema 上
 *    `book_id` が optional だが本実装では必須で渡している (parent_job_id も)。
 *    ここでは「子 Job 行が 1 件 + status='queued' + parent_job_id + kind 一致」を確認。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { runPipelineBookMarketer } from '../../apps/worker/src/tasks/pipeline-book-marketer.js';
import { invalidateApiKeyCache } from '@a2p/agents/lib/get-api-key';

const SKIP_REAL_API = process.env.PLAYWRIGHT_SKIP_REAL_API === '1';
const TEST_TAG = 't-03-04-runtime-test';

test.describe('runtime: pipeline.book.marketer worker task (T-03-04)', () => {
  // claude-opus-4-7 + DB I/O + BookLock acquire/release で 60-180s 程度想定
  test.setTimeout(300_000);

  let accountId: string;
  let themeId: string;
  let bookId: string;
  let jobId: string;

  test.beforeAll(async () => {
    if (SKIP_REAL_API) return;
    invalidateApiKeyCache();

    // 1) 一時 Account (status='archived' でダッシュボードに出さない)
    const account = await prisma.account.create({
      data: {
        pen_name: `e2e-pipe-marketer-${Date.now()}`,
        genre_policy_json: {
          primary_genre: 'business',
          ratio: { business: 1 },
          focus_themes: ['remote_work'],
        },
        status: 'archived',
      },
    });
    accountId = account.id;

    // 2) 一時 ThemeCandidate (status='accepted' = T-03-01 採用済テーマ相当)
    //    competitors_json / signals_json は T-03-01 想定形式で投入。
    const theme = await prisma.themeCandidate.create({
      data: {
        account_id: accountId,
        theme_session_id: `${TEST_TAG}-session-${Date.now()}`,
        genre: 'business',
        title: 'リモートワーク時代のチームマネジメント実践ガイド',
        subtitle: '心理的安全性と成果を両立する 5 つのフレームワーク',
        hook:
          'リモート/ハイブリッド環境で信頼ベースの組織を作るための実務マニュアル',
        target_reader: '中小企業〜大企業の課長・部長クラス（30〜50歳）',
        competitors_json: [
          {
            title: '心理的安全性のつくりかた',
            url: 'https://example.com/comp1',
            asin: 'B0XEXAMPLE1',
          },
          {
            title: 'リモートチームの教科書',
            url: 'https://example.com/comp2',
            asin: 'B0XEXAMPLE2',
          },
        ],
        signals_json: {
          reasoning: 'リモート定着で需要継続、競合は中堅理論書中心',
          market_score: 72,
          predicted_chapters: 7,
          search_keywords: ['リモートワーク', 'チームマネジメント'],
          search_volume: 18000,
          rank_estimate: 25000,
          sources: ['amazon_search', 'google_trends'],
        },
        status: 'accepted',
        decided_at: new Date(),
      },
    });
    themeId = theme.id;

    // 3) 一時 Book (theme_id 結線済、status='queued')
    const book = await prisma.book.create({
      data: {
        account_id: accountId,
        theme_id: themeId,
        title: theme.title,
        subtitle: theme.subtitle,
        status: 'queued',
        prompt_version_ids_json: {},
        model_assignment_snapshot: {},
      },
    });
    bookId = book.id;

    // 4) 内部 Job (kind='pipeline.book.marketer', status='queued')
    //    これが docs/05 §5.3.2 の `job_id` (内部 Job.id) になる。
    const job = await prisma.job.create({
      data: {
        kind: 'pipeline.book.marketer',
        book_id: bookId,
        status: 'queued',
        payload_json: {
          source: 'e2e/pipeline-book-marketer-runtime.spec.ts',
        },
      },
    });
    jobId = job.id;

    // 5) 念のため: 既存の BookLock / KdpMetadata 残骸を除去 (テストの独立性)
    await prisma.bookLock
      .deleteMany({ where: { book_id: bookId } })
      .catch(() => undefined);
  });

  test.afterAll(async () => {
    if (SKIP_REAL_API) return;

    // 順序: token_usage → KdpMetadata → 子 Job → 親 Job → BookLock → Book → Theme → Account
    if (jobId) {
      await prisma.tokenUsage
        .deleteMany({ where: { job_id: jobId } })
        .catch(() => undefined);
    }
    if (bookId) {
      await prisma.kdpMetadata
        .deleteMany({ where: { book_id: bookId } })
        .catch(() => undefined);
      await prisma.bookLock
        .deleteMany({ where: { book_id: bookId } })
        .catch(() => undefined);
    }
    // 子 Job (parent_job_id=<marketer jobId>) を先に消す (parent FK 整合)
    if (jobId) {
      await prisma.job
        .deleteMany({ where: { parent_job_id: jobId } })
        .catch(() => undefined);
      await prisma.job.delete({ where: { id: jobId } }).catch(() => undefined);
    }
    if (bookId) {
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

  test('runPipelineBookMarketer 実行 → CAS / BookLock / KdpMetadata INSERT / token_usage / 子 Job / addJob', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // 事前確認: 当該 Job は queued、KdpMetadata 未作成、token_usage 0 件、BookLock 0 件
    const initialJob = await prisma.job.findUnique({ where: { id: jobId } });
    expect(initialJob?.status).toBe('queued');
    expect(initialJob?.started_at).toBeNull();
    expect(initialJob?.finished_at).toBeNull();

    const initialKdp = await prisma.kdpMetadata.findUnique({
      where: { book_id: bookId },
    });
    expect(initialKdp).toBeNull();

    const initialUsage = await prisma.tokenUsage.count({
      where: { job_id: jobId },
    });
    expect(initialUsage).toBe(0);

    const initialLocks = await prisma.bookLock.count({
      where: { book_id: bookId },
    });
    expect(initialLocks).toBe(0);

    // --- 実呼出 -----------------------------------------------------------
    // addJob は spy。generateMetadata / acquireLock / releaseLock は本物 (DI なし)。
    const addJobCalls: Array<{
      identifier: string;
      payload: unknown;
      spec?: Record<string, unknown>;
    }> = [];
    const addJob = (async (
      identifier: string,
      payload: unknown,
      spec?: Record<string, unknown>,
    ) => {
      addJobCalls.push({ identifier, payload, ...(spec !== undefined ? { spec } : {}) });
      return { id: `mock_graphile_${addJobCalls.length}` };
    });

    await runPipelineBookMarketer(
      { book_id: bookId, job_id: jobId },
      addJob,
    );

    // --- 1) Job CAS: queued → running → done ------------------------------
    const finalJob = await prisma.job.findUnique({ where: { id: jobId } });
    expect(finalJob).not.toBeNull();
    expect(finalJob!.status).toBe('done');
    expect(finalJob!.started_at).not.toBeNull();
    expect(finalJob!.finished_at).not.toBeNull();
    // started_at <= finished_at
    expect(
      finalJob!.finished_at!.getTime() - finalJob!.started_at!.getTime(),
    ).toBeGreaterThanOrEqual(0);
    expect(finalJob!.error).toBeNull();
    // result_json には kdp_metadata_id が入っているはず
    expect(finalJob!.result_json).not.toBeNull();
    const resultJson = finalJob!.result_json as Record<string, unknown>;
    expect(typeof resultJson.kdp_metadata_id).toBe('string');

    // --- 2) BookLock: 取得→解放されている (0 件) --------------------------
    const finalLocks = await prisma.bookLock.findMany({
      where: { book_id: bookId },
    });
    expect(finalLocks).toHaveLength(0);

    // --- 3) KdpMetadata INSERT (book_id @unique → 1 行) -------------------
    const kdp = await prisma.kdpMetadata.findUnique({
      where: { book_id: bookId },
    });
    expect(kdp).not.toBeNull();
    expect(kdp!.book_id).toBe(bookId);
    expect(kdp!.id).toBe(resultJson.kdp_metadata_id);

    // F-040 制約: description 50〜4000 字
    expect(kdp!.description.length).toBeGreaterThanOrEqual(50);
    expect(kdp!.description.length).toBeLessThanOrEqual(4000);

    // keywords 1〜7 個 / 各 50 字以下
    expect(kdp!.keywords.length).toBeGreaterThanOrEqual(1);
    expect(kdp!.keywords.length).toBeLessThanOrEqual(7);
    for (const k of kdp!.keywords) {
      expect(typeof k).toBe('string');
      expect(k.length).toBeGreaterThan(0);
      expect(k.length).toBeLessThanOrEqual(50);
    }

    // categories ちょうど 2 個
    expect(kdp!.categories).toHaveLength(2);
    for (const c of kdp!.categories) {
      expect(typeof c).toBe('string');
      expect(c.length).toBeGreaterThan(0);
    }

    // price_jpy 99 円以上
    expect(kdp!.price_jpy).toBeGreaterThanOrEqual(99);
    expect(kdp!.price_jpy).toBeLessThanOrEqual(99999);
    expect(Number.isInteger(kdp!.price_jpy)).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `[T-03-04 kdp] description.length=${kdp!.description.length} ` +
        `keywords=[${kdp!.keywords.join(', ')}] ` +
        `categories=${kdp!.categories.length} ` +
        `price=${kdp!.price_jpy}`,
    );

    // --- 4) token_usage: 内部 Job.id 紐付けで 1 行 ------------------------
    const usageRows = await prisma.tokenUsage.findMany({
      where: { job_id: jobId },
    });
    expect(usageRows).toHaveLength(1);
    const usage = usageRows[0]!;
    expect(usage.provider).toBe('anthropic');
    expect(usage.role).toBe('marketer');
    expect(usage.job_id).toBe(jobId);
    // model は ModelAssignment 経由で claude-opus-4-7
    expect(usage.model).toBe('claude-opus-4-7');
    expect(usage.input_tokens).toBeGreaterThan(100);
    expect(usage.output_tokens).toBeGreaterThan(0);
    expect(usage.image_count).toBe(0);

    // eslint-disable-next-line no-console
    console.log(
      `[T-03-04 token_usage] input=${usage.input_tokens} output=${usage.output_tokens} ` +
        `cached=${usage.cached_input_tokens} cost_jpy=${usage.cost_jpy.toString()}`,
    );

    // --- 5) 子 Job 行 INSERT (kind='pipeline.book.writer.outline') ---------
    const children = await prisma.job.findMany({
      where: { parent_job_id: jobId },
    });
    expect(children).toHaveLength(1);
    const child = children[0]!;
    expect(child.kind).toBe('pipeline.book.writer.outline');
    expect(child.book_id).toBe(bookId);
    expect(child.parent_job_id).toBe(jobId);
    expect(child.status).toBe('queued');
    // child payload_json に book_id が含まれる (実装は { book_id } のみ書き込み)
    const childPayload = child.payload_json as Record<string, unknown>;
    expect(childPayload.book_id).toBe(bookId);

    // --- 6) addJob spy: pipeline.book.writer.outline + 子 Job.id payload ---
    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]!.identifier).toBe('pipeline.book.writer.outline');
    const enqPayload = addJobCalls[0]!.payload as Record<string, unknown>;
    expect(enqPayload.book_id).toBe(bookId);
    // 子 Job.id (NOT 親 marketer jobId) が乗っている
    expect(enqPayload.job_id).toBe(child.id);
    expect(enqPayload.job_id).not.toBe(jobId);
    // spec.maxAttempts=3
    expect(addJobCalls[0]!.spec).toMatchObject({ maxAttempts: 3 });
  });
});
