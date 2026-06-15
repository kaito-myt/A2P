/**
 * Runtime verification spec for T-03-05 — `pipeline.book.kickoff` worker タスク
 *
 * SP-03 段階で SP-04 以降の UI/API パイプ起点 (S-018 自動化計画 → kickoff) はまだ
 * 配線されていないため、通常の Playwright (ブラウザ操作 → DOM 検証) では F-010
 * の worker 統合面を検証できない。代わりに以下を Node ランタイム上で直接呼び出して
 * 検証する。本 spec は **LLM/外部 API 呼出ゼロ** (kickoff は純粋 DB 処理) なので
 * コストゼロで動かせる。
 *
 *   1. 一時 Account + ThemeCandidate (status='pending') + 内部 Job
 *      (kind='pipeline.book.kickoff', status='queued') を Prisma で投入
 *   2. `runPipelineBookKickoff({ theme_id, account_id, job_id }, addJob, deps)` を
 *      直接呼出。deps は **何も渡さない** = 実 prisma + 実 loadModelAssignment +
 *      実 loadActivePrompt + 実 acquireBookLock + 実 releaseBookLock を素通しで使う。
 *      addJob は spy にして子 enqueue ペイロードを観測する。
 *   3. 検証 (docs/05 §5.3.1 / F-010 受入基準):
 *      - **CAS**: 内部 Job 行が `queued` → `running` → `done` に遷移、
 *        started_at / finished_at 設定、error=null
 *      - **Book INSERT**: account_id + theme_id 一致で 1 行存在、title/subtitle が
 *        theme から、status='queued'、cost_jpy_total=0
 *      - **model_assignment_snapshot**: 7 役 (marketer, writer, editor, judge,
 *        thumbnail_text, thumbnail_image, optimizer) が含まれ、各エントリは
 *        { provider, model } の形
 *      - **prompt_version_ids_json**: 7 役分の prompt_id が記録される
 *      - **Job.book_id 確定**: kickoff Job.book_id = 新 Book.id (T-03-05 iter 2 修正)
 *      - **ThemeCandidate.status='accepted'** + decided_at 設定
 *      - **子 Job INSERT**: kind='pipeline.book.marketer', parent_job_id=<kickoff jobId>,
 *        book_id=<新 Book.id>, status='queued' で 1 行
 *      - **addJob spy**: identifier='pipeline.book.marketer', payload に book_id +
 *        子 Job.id (NOT 親 jobId), spec.maxAttempts=3
 *      - **BookLock 解放**: BookLock 行 0 件 (取得→解放)
 *      - **kickoff Job.result_json**: { book_id, marketer_job_id }
 *   4. 冪等性検証: 同じ jobId で再呼出 → 早期 return (job.status='done' 検知)、
 *      Book 累計 1 行のまま、子 Job 追加なし、addJob 追加呼出なし
 *   5. クリーンアップ: 子 Job → 親 Job → BookLock → Book → ThemeCandidate → Account
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner
 *     として借用し、@a2p/db / apps/worker/.../pipeline-book-kickoff を直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と
 *     .env.local (DATABASE_URL) が前提。
 *     ModelAssignment 7 役 (genre=null active) + Prompt 28 件 (7 役 × 4 ジャンル軸)
 *     が seed 済であることも前提。
 *
 * コスト: ゼロ (LLM 呼出なし、DB I/O のみ、BookLock acquire/release の 2 SQL のみ)
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { runPipelineBookKickoff } from '../../apps/worker/src/tasks/pipeline-book-kickoff.js';

const TEST_TAG = 't-03-05-runtime-test';

interface AddJobCall {
  identifier: string;
  payload: unknown;
  spec?: Record<string, unknown>;
}

test.describe('runtime: pipeline.book.kickoff worker task (T-03-05)', () => {
  // 純 DB のみだが冪等性 2 回呼出 + クリーンアップ込みでも 60s で十分
  test.setTimeout(60_000);

  let accountId: string;
  let themeId: string;
  let jobId: string;
  // 動的に作られる Book.id (afterAll クリーンアップ用)
  let createdBookId: string | null = null;
  // 動的に作られる子 marketer Job.id (afterAll クリーンアップ用)
  let createdMarketerJobId: string | null = null;

  test.beforeAll(async () => {
    // 1) 一時 Account (status='archived' でダッシュボードに出さない)
    const account = await prisma.account.create({
      data: {
        pen_name: `e2e-pipe-kickoff-${Date.now()}`,
        genre_policy_json: {
          primary_genre: 'business',
          ratio: { business: 1 },
          focus_themes: ['remote_work'],
        },
        status: 'archived',
      },
    });
    accountId = account.id;

    // 2) 一時 ThemeCandidate (status='pending' — kickoff が accepted に遷移させる)
    //    competitors_json / signals_json は T-03-01 想定形式で投入。
    const theme = await prisma.themeCandidate.create({
      data: {
        account_id: accountId,
        theme_session_id: `${TEST_TAG}-session-${Date.now()}`,
        genre: 'business',
        title: 'チームマネジメントを変える 1on1 の科学',
        subtitle: '心理的安全性と成果を両立する週次対話術',
        hook: 'ハイブリッド組織でも信頼を作り続ける 1on1 のフレームワーク',
        target_reader: '管理職 1〜3 年目の課長クラス',
        competitors_json: [
          {
            title: '1on1 の教科書',
            url: 'https://example.com/comp1',
            asin: 'B0XKICKOFF1',
          },
        ],
        signals_json: {
          reasoning: '管理職教育需要が継続、競合は教科書系のみ',
          market_score: 68,
          predicted_chapters: 6,
          search_keywords: ['1on1', 'マネジメント'],
          search_volume: 12000,
          rank_estimate: 30000,
          sources: ['amazon_search'],
        },
        status: 'pending',
      },
    });
    themeId = theme.id;

    // 3) 内部 Job (kind='pipeline.book.kickoff', status='queued')
    //    これが docs/05 §5.3.1 の `job_id` (内部 Job.id) になる。
    //    Book は **kickoff が作る** ので、ここでは book_id を持たない。
    const job = await prisma.job.create({
      data: {
        kind: 'pipeline.book.kickoff',
        status: 'queued',
        payload_json: {
          source: 'e2e/pipeline-book-kickoff-runtime.spec.ts',
          theme_id: themeId,
          account_id: accountId,
        },
      },
    });
    jobId = job.id;
  });

  test.afterAll(async () => {
    // 順序: 子 Job (parent_job_id=jobId) → 親 Job → BookLock → Book → Theme → Account
    if (jobId) {
      await prisma.job
        .deleteMany({ where: { parent_job_id: jobId } })
        .catch(() => undefined);
      await prisma.job.delete({ where: { id: jobId } }).catch(() => undefined);
    }
    if (createdBookId) {
      await prisma.bookLock
        .deleteMany({ where: { book_id: createdBookId } })
        .catch(() => undefined);
      await prisma.book
        .delete({ where: { id: createdBookId } })
        .catch(() => undefined);
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

  test('runPipelineBookKickoff 実 DB → CAS / Book INSERT / snapshot 7 役 / Job.book_id 確定 / theme accepted / 子 Job / addJob / BookLock 解放', async () => {
    // --- 事前確認 ---------------------------------------------------------
    const initialJob = await prisma.job.findUnique({ where: { id: jobId } });
    expect(initialJob?.status).toBe('queued');
    expect(initialJob?.book_id).toBeNull();
    expect(initialJob?.started_at).toBeNull();
    expect(initialJob?.finished_at).toBeNull();

    const initialBookCount = await prisma.book.count({
      where: { account_id: accountId, theme_id: themeId },
    });
    expect(initialBookCount).toBe(0);

    const initialChildCount = await prisma.job.count({
      where: { parent_job_id: jobId },
    });
    expect(initialChildCount).toBe(0);

    const initialThemeStatus = await prisma.themeCandidate.findUnique({
      where: { id: themeId },
      select: { status: true, decided_at: true },
    });
    expect(initialThemeStatus?.status).toBe('pending');
    expect(initialThemeStatus?.decided_at).toBeNull();

    // --- 実呼出 -----------------------------------------------------------
    // addJob は spy。loadModelAssignment / loadActivePrompt / acquireLock /
    // releaseLock は本物 (DI なし)。
    const addJobCalls: AddJobCall[] = [];
    const addJob = async (
      identifier: string,
      payload: unknown,
      spec?: Record<string, unknown>,
    ) => {
      addJobCalls.push({
        identifier,
        payload,
        ...(spec !== undefined ? { spec } : {}),
      });
      return { id: `mock_graphile_${addJobCalls.length}` };
    };

    await runPipelineBookKickoff(
      { theme_id: themeId, account_id: accountId, job_id: jobId },
      addJob,
    );

    // --- 1) Job CAS: queued → running → done ------------------------------
    const finalJob = await prisma.job.findUnique({ where: { id: jobId } });
    expect(finalJob).not.toBeNull();
    expect(finalJob!.status).toBe('done');
    expect(finalJob!.started_at).not.toBeNull();
    expect(finalJob!.finished_at).not.toBeNull();
    expect(
      finalJob!.finished_at!.getTime() - finalJob!.started_at!.getTime(),
    ).toBeGreaterThanOrEqual(0);
    expect(finalJob!.error).toBeNull();

    // result_json: { book_id, marketer_job_id }
    expect(finalJob!.result_json).not.toBeNull();
    const resultJson = finalJob!.result_json as Record<string, unknown>;
    expect(typeof resultJson.book_id).toBe('string');
    expect(typeof resultJson.marketer_job_id).toBe('string');

    // --- 2) Book INSERT (account_id + theme_id で 1 行) -------------------
    const books = await prisma.book.findMany({
      where: { account_id: accountId, theme_id: themeId },
    });
    expect(books).toHaveLength(1);
    const book = books[0]!;
    createdBookId = book.id; // クリーンアップ用に保存
    expect(book.title).toBe('チームマネジメントを変える 1on1 の科学');
    expect(book.subtitle).toBe('心理的安全性と成果を両立する週次対話術');
    expect(book.status).toBe('queued');
    expect(Number(book.cost_jpy_total)).toBe(0);
    // result_json.book_id と一致
    expect(book.id).toBe(resultJson.book_id);

    // --- 3) model_assignment_snapshot: 7 役 -------------------------------
    const snapshot = book.model_assignment_snapshot as Record<
      string,
      { provider: string; model: string }
    >;
    expect(snapshot).not.toBeNull();
    const snapshotRoles = Object.keys(snapshot).sort();
    expect(snapshotRoles).toEqual(
      [
        'editor',
        'judge',
        'marketer',
        'optimizer',
        'thumbnail_image',
        'thumbnail_text',
        'writer',
      ].sort(),
    );
    // 各役で provider/model が文字列で埋まっている (seed 由来)
    for (const role of snapshotRoles) {
      expect(typeof snapshot[role]!.provider).toBe('string');
      expect(snapshot[role]!.provider.length).toBeGreaterThan(0);
      expect(typeof snapshot[role]!.model).toBe('string');
      expect(snapshot[role]!.model.length).toBeGreaterThan(0);
    }
    // seed の代表例だけ scoped check (docs/01 §7.3)
    expect(snapshot.marketer!.provider).toBe('anthropic');
    expect(snapshot.marketer!.model).toBe('claude-opus-4-7');
    expect(snapshot.thumbnail_image!.provider).toBe('openai');
    expect(snapshot.thumbnail_image!.model).toBe('gpt-image-1');

    // --- 4) prompt_version_ids_json: 7 役分の prompt_id -------------------
    const promptIds = book.prompt_version_ids_json as Record<string, string>;
    expect(promptIds).not.toBeNull();
    const promptRoles = Object.keys(promptIds).sort();
    expect(promptRoles).toEqual(snapshotRoles);
    for (const role of promptRoles) {
      expect(typeof promptIds[role]).toBe('string');
      expect(promptIds[role]!.length).toBeGreaterThan(0);
    }

    // --- 5) Job.book_id 確定 (T-03-05 iter 2 idempotency 修正) ------------
    expect(finalJob!.book_id).toBe(book.id);

    // --- 6) ThemeCandidate.status='accepted' + decided_at -----------------
    const finalTheme = await prisma.themeCandidate.findUnique({
      where: { id: themeId },
      select: { status: true, decided_at: true },
    });
    expect(finalTheme?.status).toBe('accepted');
    expect(finalTheme?.decided_at).not.toBeNull();

    // --- 7) 子 Job INSERT (kind='pipeline.book.marketer') -----------------
    const children = await prisma.job.findMany({
      where: { parent_job_id: jobId },
    });
    expect(children).toHaveLength(1);
    const child = children[0]!;
    createdMarketerJobId = child.id;
    expect(child.kind).toBe('pipeline.book.marketer');
    expect(child.book_id).toBe(book.id);
    expect(child.parent_job_id).toBe(jobId);
    expect(child.status).toBe('queued');
    // child payload_json に book_id が含まれる (実装は { book_id } のみ書き込み)
    const childPayload = child.payload_json as Record<string, unknown>;
    expect(childPayload.book_id).toBe(book.id);
    // result_json.marketer_job_id と一致
    expect(child.id).toBe(resultJson.marketer_job_id);

    // --- 8) addJob spy: pipeline.book.marketer + 子 Job.id payload --------
    expect(addJobCalls).toHaveLength(1);
    expect(addJobCalls[0]!.identifier).toBe('pipeline.book.marketer');
    const enqPayload = addJobCalls[0]!.payload as Record<string, unknown>;
    expect(enqPayload.book_id).toBe(book.id);
    // 子 Job.id (NOT 親 kickoff jobId) が乗っている
    expect(enqPayload.job_id).toBe(child.id);
    expect(enqPayload.job_id).not.toBe(jobId);
    expect(addJobCalls[0]!.spec).toMatchObject({ maxAttempts: 3 });

    // --- 9) BookLock 解放: BookLock 行 0 件 -------------------------------
    const finalLocks = await prisma.bookLock.findMany({
      where: { book_id: book.id },
    });
    expect(finalLocks).toHaveLength(0);

    // eslint-disable-next-line no-console
    console.log(
      `[T-03-05 kickoff] book_id=${book.id} marketer_job_id=${child.id} ` +
        `snapshot_roles=${snapshotRoles.length} prompt_ids=${promptRoles.length}`,
    );

    // ===================================================================
    // 冪等性検証 — 同じ jobId で再呼出
    // ===================================================================
    // Job.status は既に 'done' のため、早期 return するはず。
    // → Book 累計 1 行のまま、子 Job 追加なし、addJob 追加呼出なし。

    const beforeIdempotentBookCount = await prisma.book.count({
      where: { account_id: accountId, theme_id: themeId },
    });
    const beforeIdempotentChildCount = await prisma.job.count({
      where: { parent_job_id: jobId },
    });
    const beforeIdempotentAddJobCalls = addJobCalls.length;

    await runPipelineBookKickoff(
      { theme_id: themeId, account_id: accountId, job_id: jobId },
      addJob,
    );

    // Book 数増えていない
    const afterBookCount = await prisma.book.count({
      where: { account_id: accountId, theme_id: themeId },
    });
    expect(afterBookCount).toBe(beforeIdempotentBookCount);
    expect(afterBookCount).toBe(1);

    // 子 Job 数増えていない
    const afterChildCount = await prisma.job.count({
      where: { parent_job_id: jobId },
    });
    expect(afterChildCount).toBe(beforeIdempotentChildCount);
    expect(afterChildCount).toBe(1);

    // addJob 追加呼出なし
    expect(addJobCalls).toHaveLength(beforeIdempotentAddJobCalls);
    expect(addJobCalls).toHaveLength(1);

    // Job は依然として done のまま
    const finalJobAfterIdempotent = await prisma.job.findUnique({
      where: { id: jobId },
    });
    expect(finalJobAfterIdempotent!.status).toBe('done');
    expect(finalJobAfterIdempotent!.book_id).toBe(book.id);

    // eslint-disable-next-line no-console
    console.log(
      `[T-03-05 idempotent] re-invoke skipped — book_count=${afterBookCount}, ` +
        `child_count=${afterChildCount}, addJob_calls=${addJobCalls.length}`,
    );
  });
});
