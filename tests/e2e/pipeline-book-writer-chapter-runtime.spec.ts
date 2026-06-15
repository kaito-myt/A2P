/**
 * Runtime verification spec for T-04-05 — `pipeline.book.writer.chapter` worker task +
 * `pipeline.book.writer.chapters.dispatch` 親タスク
 *
 * SP-04 段階では bulkApproveOutlines SA (T-04-07) から dispatch を起動する経路はまだ
 * 配線されていないため、通常の Playwright (ブラウザ操作 → DOM 検証) では F-004 / F-011
 * の worker 統合面を検証できない。代わりに以下を Node ランタイム上で直接呼び出して検証する:
 *
 *   1. **準備**: 一時 Account + ThemeCandidate (accepted) + Book (theme_id 結線) +
 *      KdpMetadata + Outline (status='approved', chapters_json=4 章 / 各 target_chars=2000) を
 *      Prisma で投入。dispatch 用の内部 Job (queued) も投入。
 *   2. **dispatch 実行** (LLM コスト 0 — DB INSERT + addJob mock のみ):
 *      `runPipelineBookWriterChaptersDispatch({ payload, addJob: spy, deps: {} })` を直接呼出。
 *      検証:
 *       - 4 個の `pipeline.book.writer.chapter` Job 行が INSERT (parent_job_id=dispatchJobId,
 *         payload_json に chapter_index)
 *       - addJob spy が 4 回呼ばれ、identifier='pipeline.book.writer.chapter' で各章 1 回
 *       - dispatch Job 自体は status='done' + result_json.{total_chapters, enqueued, children}
 *   3. **再 dispatch (冪等性)** — 同 dispatch Job を新規作成して 2 回目呼出:
 *      step 4 (alreadyEnqueuedIndices) で全章 skip され、addJob 0 回 + result_json.enqueued=0
 *      + skipped_already_enqueued=4。
 *   4. **章 worker 実行 (chapter_index=1, 実 LLM — コスト ~$0.03-0.05)**:
 *      dispatch で生成された chapter_index=1 の Job を `runPipelineBookWriterChapter` で
 *      直接実行 (DI なし、本物の generateChapter)。
 *      検証:
 *       - Chapter 1 行が upsert (book_id_index unique で 1 行)、body_md 非空、char_count
 *         一致 (codepoint)、status='done'
 *       - Job status='done'、result_json.{chapter_id, chapter_index:1, is_last:false}
 *       - token_usage role='writer', provider='anthropic', book_id+job_id 紐付け 1 行
 *       - editor Job は **enqueue されていない** (まだ最終章でないため)
 *   5. **完了監視 → editor enqueue 検証** (LLM コスト 0 — 残り 3 章は DB 直接投入):
 *      Chapter 2/3/4 を Prisma 直接投入 (LLM スキップ) → chapter_index=4 の Job を再実行
 *      する代わりに、最終章のロジックだけ検証するため、chapter_index=4 の Job を直接呼ぶと
 *      LLM コストがかかる。そこで「最終章 worker が editor enqueue する」核心は、
 *      mock generateChapter + 残り 3 章 DB 投入 + chapter_index=4 worker 直接呼出 で検証する。
 *      検証:
 *       - chapter_index=4 完了後、Chapter.count === 4
 *       - `pipeline.book.editor` Job が 1 行 INSERT (parent_job_id=<本章 jobId>, status='queued')
 *       - addJob spy が 'pipeline.book.editor' で 1 回呼ばれている
 *       - chapter_index=4 Job の result_json.{is_last:true, editor_job_id}
 *   6. **editor 二重 enqueue ガード検証** (LLM コスト 0 — mock):
 *      同じ最終章を再実行 (Job を queued に戻す + Chapter を再 upsert 同行) →
 *      既存 editor Job が見つかり、新規 enqueue されないこと (addJob 'pipeline.book.editor'
 *      の呼出回数が増えない)。
 *   7. **クリーンアップ**: token_usage / Chapter / Outline / KdpMetadata / Job / BookLock /
 *      Book / ThemeCandidate / Account 全削除
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner として
 *     借用し、@a2p/db / apps/worker/.../pipeline-book-writer-chapter(s-dispatch) を直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と
 *     .env.local (ANTHROPIC_API_KEY / DATABASE_URL / AUTH_*) が前提。
 *     ModelAssignment (writer, anthropic, claude-sonnet-4-6) + Prompt (role='writer',
 *     genre=null active) が seed 済であることも前提。
 *     addJob は **mock** で受ける (graphile-worker への実 enqueue は本 spec の検証対象外、
 *     enqueue 呼出の identifier / payload / spec の正しさだけを spy で記録する)。
 *
 * コスト: writer chapter 1 呼出 ≒ input ~2000 + output ~3000-5000 tokens
 *         (target_chars=2000 + ±20% = 1600-2400 字, claude-sonnet-4-6) ≒ ~$0.03-0.05 / run
 *         (~5-8 円)。dispatch は LLM 不使用なのでコスト 0。
 *         残り 3 章 + editor enqueue 検証は mock generateChapter で代替するためコスト 0。
 *         CI ではスキップ可 (PLAYWRIGHT_SKIP_REAL_API=1)。
 *
 * 設計判断 (本 spec 固有):
 *  - generateChapter / notifyJobChange は **chapter_index=1 のみ実 LLM**、それ以外は mock。
 *    本 spec の核は「dispatch → 章 worker N 個 → 完了監視 → editor enqueue」の **配線**
 *    検証であり、LLM 出力品質は `writer-chapter-runtime.spec.ts` (T-04-02) で別途検証済。
 *  - addJob は **常に mock** (spy)。実 enqueue は graphile-worker の runner が必要で
 *    本 spec の責務外。dispatch / chapter 双方の addJob 契約 (identifier / payload / spec)
 *    を spy で記録して検証する。
 *  - 4 章構成 (F-003 最小 7 章を緩める) — 本 spec は配線検証なので章数を抑える。実体の
 *    7-10 章は writer-outline-runtime.spec.ts (T-04-04) で別途検証済。
 *  - LLM retry: writer.chapter.invalid_output / chars_out_of_range の揺れに最大 3 回 retry。
 *    失敗時は Chapter 行と token_usage を掃除して内部 Job を queued に戻す。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { invalidateApiKeyCache } from '@a2p/agents/lib/get-api-key';
import type { WriterChapterOutput } from '@a2p/contracts/agents/writer';

import { runPipelineBookWriterChaptersDispatch } from '../../apps/worker/src/tasks/pipeline-book-writer-chapters-dispatch.js';
import { runPipelineBookWriterChapter } from '../../apps/worker/src/tasks/pipeline-book-writer-chapter.js';

const SKIP_REAL_API = process.env.PLAYWRIGHT_SKIP_REAL_API === '1';
const TEST_TAG = 't-04-05-runtime-test';

/**
 * addJob spy. graphile-worker.helpers.addJob と同形のシグネチャ。
 * 呼出履歴 (identifier / payload / spec) を records に蓄積する。
 */
function makeAddJobSpy() {
  const records: Array<{
    identifier: string;
    payload: unknown;
    spec: Record<string, unknown> | undefined;
  }> = [];
  const fn = async (
    identifier: string,
    payload: unknown,
    spec?: Record<string, unknown>,
  ): Promise<unknown> => {
    records.push({ identifier, payload, spec });
    return undefined;
  };
  return { fn, records };
}

/** 4 章 outline.chapters_json (target_chars=2000 でコスト抑制)。 */
const FOUR_CHAPTERS = [
  {
    index: 1,
    heading: 'はじめに — 変化する働き方',
    summary: 'リモートワーク時代の管理職が直面する変化を導入する',
    target_chars: 2000,
    subheadings: ['背景', '本書の構成'],
  },
  {
    index: 2,
    heading: '信頼の土台を作る',
    summary: '心理的安全性と信頼ベースの組織づくりの基本',
    target_chars: 2000,
    subheadings: ['心理的安全性とは', '信頼の構築プロセス'],
  },
  {
    index: 3,
    heading: '1on1 の設計と実践',
    summary: 'リモート環境で機能する 1on1 の進め方',
    target_chars: 2000,
    subheadings: ['頻度と時間配分', '質問のフレームワーク'],
  },
  {
    index: 4,
    heading: 'まとめ — これからの一歩',
    summary: '本書のまとめと管理職への提言',
    target_chars: 2000,
    subheadings: ['学びの統合', '明日からの行動'],
  },
];

test.describe('runtime: pipeline.book.writer.chapter + chapters.dispatch worker tasks (T-04-05)', () => {
  // dispatch 0s (LLM 不使用) + chapter 1 章 real LLM 30-90s + editor enqueue 配線
  // + mock 検証 = 合計 ~3min 目安だが LLM retry を見て 600s 上限。
  test.setTimeout(600_000);

  let accountId: string;
  let themeId: string;
  let bookId: string;
  let outlineId: string;
  /** dispatch 1 回目用 Job. */
  let dispatchJobId: string;
  /** dispatch 2 回目用 Job (冪等性検証). */
  let dispatchJobId2: string;
  /** dispatch で生成された chapter_index -> child job_id マップ. */
  const childJobIdByIndex = new Map<number, string>();

  test.beforeAll(async () => {
    if (SKIP_REAL_API) return;
    invalidateApiKeyCache();

    // 1) 一時 Account
    const account = await prisma.account.create({
      data: {
        pen_name: `e2e-pipe-writer-chap-${Date.now()}`,
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
        subtitle: '心理的安全性と成果を両立する 4 つのフレームワーク',
        hook: 'リモート/ハイブリッド環境で信頼ベースの組織を作る実務マニュアル',
        target_reader: '中小企業〜大企業の課長・部長クラス（30〜50歳）',
        competitors_json: [],
        signals_json: {
          reasoning: 'リモート定着で需要継続',
          market_score: 70,
          predicted_chapters: 4,
          search_keywords: ['リモートワーク', 'マネジメント'],
          search_volume: 15000,
          rank_estimate: 30000,
          sources: ['amazon_search'],
        },
        status: 'accepted',
        decided_at: new Date(),
      },
    });
    themeId = theme.id;

    // 3) 一時 Book (theme_id 結線済、status='running' = marketer + outline 完了想定)
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

    // 4) KdpMetadata
    await prisma.kdpMetadata.create({
      data: {
        book_id: bookId,
        description:
          'リモートワーク時代の管理職に向けた実践ガイド。心理的安全性と成果を両立する 4 つのフレームワークを提供する。',
        keywords: ['リモートワーク', 'チームマネジメント', '心理的安全性'],
        categories: ['ビジネス・経済 > マネジメント・人材管理'],
        price_jpy: 980,
      },
    });

    // 5) Outline (status='approved'、4 章 chapters_json)
    const outline = await prisma.outline.create({
      data: {
        book_id: bookId,
        chapters_json: FOUR_CHAPTERS,
        status: 'approved',
        approved_at: new Date(),
      },
    });
    outlineId = outline.id;

    // 6) dispatch 1 回目用 Job (queued)
    const dispatchJob = await prisma.job.create({
      data: {
        kind: 'pipeline.book.writer.chapters.dispatch',
        book_id: bookId,
        status: 'queued',
        payload_json: {
          source: 'e2e/pipeline-book-writer-chapter-runtime.spec.ts',
          book_id: bookId,
          outline_id: outlineId,
        },
      },
    });
    dispatchJobId = dispatchJob.id;

    // 既存 BookLock 残骸を除去
    await prisma.bookLock
      .deleteMany({ where: { book_id: bookId } })
      .catch(() => undefined);
  });

  test.afterAll(async () => {
    if (SKIP_REAL_API) return;

    // 順序: token_usage → Chapter → Outline → KdpMetadata → BookLock → Job → Book → Theme → Account
    if (bookId) {
      await prisma.tokenUsage
        .deleteMany({ where: { book_id: bookId } })
        .catch(() => undefined);
      await prisma.chapter
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

  // ===========================================================================
  // Test 1 — dispatch: 4 章 Job INSERT + 4 addJob 呼出 (LLM 不使用)
  // ===========================================================================
  test('dispatch 実行 → 4 個の chapter Job INSERT + 4 addJob 呼出 + dispatch Job done', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // 事前確認
    const initialJob = await prisma.job.findUnique({ where: { id: dispatchJobId } });
    expect(initialJob?.status).toBe('queued');

    const initialChapterJobs = await prisma.job.count({
      where: { book_id: bookId, kind: 'pipeline.book.writer.chapter' },
    });
    expect(initialChapterJobs).toBe(0);

    // --- dispatch 直接呼出 (addJob mock, deps={} で本物 prisma) -------------
    const addJobSpy = makeAddJobSpy();
    await runPipelineBookWriterChaptersDispatch(
      {
        book_id: bookId,
        job_id: dispatchJobId,
        outline_id: outlineId,
      },
      addJobSpy.fn,
    );

    // --- 検証 1: addJob spy が 4 回呼ばれている -----------------------------
    expect(addJobSpy.records).toHaveLength(4);
    for (const rec of addJobSpy.records) {
      expect(rec.identifier).toBe('pipeline.book.writer.chapter');
      expect(rec.spec).toEqual({ maxAttempts: 3 });
      const payload = rec.payload as {
        book_id: string;
        job_id: string;
        outline_id: string;
        chapter_index: number;
      };
      expect(payload.book_id).toBe(bookId);
      expect(payload.outline_id).toBe(outlineId);
      expect(typeof payload.job_id).toBe('string');
      expect(payload.job_id.length).toBeGreaterThan(0);
      expect(payload.chapter_index).toBeGreaterThanOrEqual(1);
      expect(payload.chapter_index).toBeLessThanOrEqual(4);
    }
    // chapter_index は 1..4 の重複なし
    const calledIndices = addJobSpy.records
      .map((r) => (r.payload as { chapter_index: number }).chapter_index)
      .sort((a, b) => a - b);
    expect(calledIndices).toEqual([1, 2, 3, 4]);

    // --- 検証 2: chapter Job 行が 4 つ INSERT されている --------------------
    const childJobs = await prisma.job.findMany({
      where: {
        book_id: bookId,
        kind: 'pipeline.book.writer.chapter',
      },
      orderBy: { created_at: 'asc' },
    });
    expect(childJobs).toHaveLength(4);
    for (const job of childJobs) {
      expect(job.parent_job_id).toBe(dispatchJobId);
      expect(job.status).toBe('queued');
      const payload = job.payload_json as {
        book_id: string;
        outline_id: string;
        chapter_index: number;
      };
      expect(payload.book_id).toBe(bookId);
      expect(payload.outline_id).toBe(outlineId);
      expect(payload.chapter_index).toBeGreaterThanOrEqual(1);
      expect(payload.chapter_index).toBeLessThanOrEqual(4);
      childJobIdByIndex.set(payload.chapter_index, job.id);
    }
    // 4 章すべて map に入っている
    expect([...childJobIdByIndex.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);

    // --- 検証 3: dispatch Job 自体が done に遷移、result_json 充足 -----------
    const finalDispatchJob = await prisma.job.findUnique({
      where: { id: dispatchJobId },
    });
    expect(finalDispatchJob!.status).toBe('done');
    expect(finalDispatchJob!.started_at).not.toBeNull();
    expect(finalDispatchJob!.finished_at).not.toBeNull();
    expect(finalDispatchJob!.error).toBeNull();
    const dispatchResult = finalDispatchJob!.result_json as {
      total_chapters: number;
      enqueued: number;
      skipped_already_enqueued: number;
      chapter_concurrency: number;
      children: Array<{ chapter_index: number; child_job_id: string }>;
    };
    expect(dispatchResult.total_chapters).toBe(4);
    expect(dispatchResult.enqueued).toBe(4);
    expect(dispatchResult.skipped_already_enqueued).toBe(0);
    expect(dispatchResult.chapter_concurrency).toBeGreaterThanOrEqual(1);
    expect(dispatchResult.children).toHaveLength(4);
    const sortedChildren = [...dispatchResult.children].sort(
      (a, b) => a.chapter_index - b.chapter_index,
    );
    expect(sortedChildren.map((c) => c.chapter_index)).toEqual([1, 2, 3, 4]);
    for (const c of sortedChildren) {
      expect(childJobIdByIndex.get(c.chapter_index)).toBe(c.child_job_id);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-05 dispatch] dispatchJobId=${dispatchJobId} ` +
        `total=${dispatchResult.total_chapters} enqueued=${dispatchResult.enqueued} ` +
        `skipped=${dispatchResult.skipped_already_enqueued} ` +
        `concurrency=${dispatchResult.chapter_concurrency}`,
    );
  });

  // ===========================================================================
  // Test 2 — dispatch 再実行 (冪等性): addJob 0 回 + skipped_already_enqueued=4
  // ===========================================================================
  test('dispatch 再実行 (新 dispatch Job) → 既存 chapter Job を skip + addJob 0 回', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // 既に dispatch1 で 4 個の chapter Job (queued) が存在することを前提
    const existingCount = await prisma.job.count({
      where: { book_id: bookId, kind: 'pipeline.book.writer.chapter' },
    });
    expect(existingCount).toBe(4);

    // 新 dispatch Job を queued で作る
    const dispatch2 = await prisma.job.create({
      data: {
        kind: 'pipeline.book.writer.chapters.dispatch',
        book_id: bookId,
        status: 'queued',
        payload_json: {
          source: 'e2e/pipeline-book-writer-chapter-runtime.spec.ts',
          book_id: bookId,
          outline_id: outlineId,
          retry: true,
        },
      },
    });
    dispatchJobId2 = dispatch2.id;

    const addJobSpy2 = makeAddJobSpy();
    await runPipelineBookWriterChaptersDispatch(
      {
        book_id: bookId,
        job_id: dispatchJobId2,
        outline_id: outlineId,
      },
      addJobSpy2.fn,
    );

    // addJob は 0 回 (全章 skip)
    expect(addJobSpy2.records).toHaveLength(0);

    // chapter Job 件数は変わらず 4
    const afterCount = await prisma.job.count({
      where: { book_id: bookId, kind: 'pipeline.book.writer.chapter' },
    });
    expect(afterCount).toBe(4);

    // dispatch2 Job も done + result_json.{enqueued:0, skipped:4}
    const finalDispatch2 = await prisma.job.findUnique({
      where: { id: dispatchJobId2 },
    });
    expect(finalDispatch2!.status).toBe('done');
    const result2 = finalDispatch2!.result_json as {
      total_chapters: number;
      enqueued: number;
      skipped_already_enqueued: number;
      children: unknown[];
    };
    expect(result2.total_chapters).toBe(4);
    expect(result2.enqueued).toBe(0);
    expect(result2.skipped_already_enqueued).toBe(4);
    expect(result2.children).toHaveLength(0);

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-05 dispatch retry] dispatchJobId2=${dispatchJobId2} ` +
        `enqueued=${result2.enqueued} skipped=${result2.skipped_already_enqueued}`,
    );
  });

  // ===========================================================================
  // Test 3 — chapter_index=1 worker 実行 (実 LLM): Chapter upsert + token_usage +
  //          editor は **未** enqueue (まだ最終章でない)
  // ===========================================================================
  test('chapter_index=1 worker 実行 → Chapter 1 行 upsert + token_usage (role=writer) + editor 未 enqueue', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    const childJobId = childJobIdByIndex.get(1);
    expect(childJobId).toBeTruthy();

    const initialChapter = await prisma.chapter.findFirst({
      where: { book_id: bookId, index: 1 },
    });
    expect(initialChapter).toBeNull();

    const initialUsage = await prisma.tokenUsage.count({
      where: { job_id: childJobId! },
    });
    expect(initialUsage).toBe(0);

    const initialEditorJobs = await prisma.job.count({
      where: { book_id: bookId, kind: 'pipeline.book.editor' },
    });
    expect(initialEditorJobs).toBe(0);

    const addJobSpy = makeAddJobSpy();

    // LLM 揺れに備え 3 回 retry。失敗時は Chapter 行 / token_usage を掃除して
    // 内部 Job を queued に戻す。
    const runWithRetry = async () => {
      const MAX_ATTEMPTS = 3;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          await runPipelineBookWriterChapter(
            {
              book_id: bookId,
              job_id: childJobId!,
              outline_id: outlineId,
              chapter_index: 1,
            },
            addJobSpy.fn,
          );
          return;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.warn(
            `[T-04-05 chapter1] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`,
          );
          const isWriterAgentError = msg.startsWith('writer.chapter.');
          if (!isWriterAgentError) throw err;
          if (attempt === MAX_ATTEMPTS) break;
          // クリーンアップ + Job 再 queued
          await prisma.tokenUsage
            .deleteMany({ where: { job_id: childJobId! } })
            .catch(() => undefined);
          await prisma.chapter
            .deleteMany({ where: { book_id: bookId, index: 1 } })
            .catch(() => undefined);
          await prisma.job.update({
            where: { id: childJobId! },
            data: { status: 'queued', started_at: null, finished_at: null, error: null },
          });
        }
      }
      if (lastErr) throw lastErr;
    };

    await runWithRetry();

    // --- 検証 1: Chapter 1 行 upsert (book_id_index unique) ----------------
    const chapter1 = await prisma.chapter.findFirst({
      where: { book_id: bookId, index: 1 },
    });
    expect(chapter1).not.toBeNull();
    expect(chapter1!.book_id).toBe(bookId);
    expect(chapter1!.index).toBe(1);
    expect(chapter1!.status).toBe('done');
    expect(chapter1!.version).toBe(1);
    expect(typeof chapter1!.heading).toBe('string');
    expect(chapter1!.heading.length).toBeGreaterThan(0);
    expect(typeof chapter1!.body_md).toBe('string');
    expect(chapter1!.body_md.length).toBeGreaterThan(0);
    expect(chapter1!.body_md).toMatch(/^#{1,3} /m); // Markdown 見出し
    // char_count = codepoint length
    const codepoints = [...chapter1!.body_md].length;
    expect(chapter1!.char_count).toBe(codepoints);
    // target_chars=2000 の ±20% 範囲 (1600〜2400)
    expect(chapter1!.char_count).toBeGreaterThanOrEqual(1600);
    expect(chapter1!.char_count).toBeLessThanOrEqual(2400);

    // --- 検証 2: 内部 Job done + result_json ---------------------------------
    const finalJob = await prisma.job.findUnique({ where: { id: childJobId! } });
    expect(finalJob!.status).toBe('done');
    expect(finalJob!.started_at).not.toBeNull();
    expect(finalJob!.finished_at).not.toBeNull();
    expect(finalJob!.error).toBeNull();
    const result = finalJob!.result_json as {
      chapter_id: string;
      chapter_index: number;
      char_count: number;
      is_last: boolean;
      editor_job_id: string | null;
    };
    expect(result.chapter_id).toBe(chapter1!.id);
    expect(result.chapter_index).toBe(1);
    expect(result.char_count).toBe(chapter1!.char_count);
    expect(result.is_last).toBe(false); // 4 章中 1 章目なので最終ではない
    expect(result.editor_job_id).toBeNull();

    // --- 検証 3: token_usage 1 行 (role='writer') ----------------------------
    const usageRows = await prisma.tokenUsage.findMany({
      where: { job_id: childJobId! },
    });
    expect(usageRows).toHaveLength(1);
    const usage = usageRows[0]!;
    expect(usage.provider).toBe('anthropic');
    expect(usage.role).toBe('writer');
    expect(usage.book_id).toBe(bookId);
    expect(usage.job_id).toBe(childJobId);
    expect(usage.model).toMatch(/^claude-/);
    expect(usage.input_tokens).toBeGreaterThan(100);
    expect(usage.output_tokens).toBeGreaterThan(0);

    // --- 検証 4: editor Job は **enqueue されていない** -----------------------
    const editorJobs = await prisma.job.findMany({
      where: { book_id: bookId, kind: 'pipeline.book.editor' },
    });
    expect(editorJobs).toHaveLength(0);

    // addJob spy: editor 呼出 0 回
    const editorAddCalls = addJobSpy.records.filter(
      (r) => r.identifier === 'pipeline.book.editor',
    );
    expect(editorAddCalls).toHaveLength(0);

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-05 chapter1] chapter_id=${chapter1!.id} char_count=${chapter1!.char_count} ` +
        `(target=2000 range=1600-2400) heading="${chapter1!.heading}"`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[T-04-05 chapter1 token_usage] model=${usage.model} input=${usage.input_tokens} ` +
        `output=${usage.output_tokens} cost_jpy=${usage.cost_jpy.toString()}`,
    );
  });

  // ===========================================================================
  // Test 4 — 完了監視 → editor enqueue 検証 (LLM コスト 0, mock generateChapter)
  //   残り 3 章 (2/3/4) のうち、2/3 を Chapter 行直接投入 + Job=done に変更し、
  //   chapter_index=4 を mock generateChapter で実行 → 最終章として editor enqueue
  // ===========================================================================
  test('chapter_index=4 (最終章) worker 実行 (mock LLM) → editor Job 1 行 INSERT + addJob 呼出', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // Chapter 2, 3 を直接投入 (他の worker が完了したシミュレーション)
    await prisma.chapter.create({
      data: {
        book_id: bookId,
        index: 2,
        heading: '信頼の土台を作る',
        body_md: '## 信頼の土台を作る\n\n本章では信頼の構築プロセスを解説する。'.padEnd(2000, 'あ'),
        status: 'done',
        char_count: 2000,
        version: 1,
      },
    });
    await prisma.chapter.create({
      data: {
        book_id: bookId,
        index: 3,
        heading: '1on1 の設計と実践',
        body_md: '## 1on1 の設計と実践\n\n本章では 1on1 の進め方を解説する。'.padEnd(2000, 'い'),
        status: 'done',
        char_count: 2000,
        version: 1,
      },
    });

    // Job 2, 3 も done に変更 (実 worker が完了した相当)
    const job2Id = childJobIdByIndex.get(2)!;
    const job3Id = childJobIdByIndex.get(3)!;
    await prisma.job.update({
      where: { id: job2Id },
      data: { status: 'done', started_at: new Date(), finished_at: new Date() },
    });
    await prisma.job.update({
      where: { id: job3Id },
      data: { status: 'done', started_at: new Date(), finished_at: new Date() },
    });

    // chapter 1 + 2 + 3 で 3 行投入済 (test 3 で 1, 直接で 2/3) → 4 章目で count===4
    const beforeChapterCount = await prisma.chapter.count({ where: { book_id: bookId } });
    expect(beforeChapterCount).toBe(3);

    const beforeEditorJobs = await prisma.job.count({
      where: { book_id: bookId, kind: 'pipeline.book.editor' },
    });
    expect(beforeEditorJobs).toBe(0);

    // --- chapter_index=4 worker 実行 (mock generateChapter) -----------------
    const job4Id = childJobIdByIndex.get(4)!;
    const addJobSpy = makeAddJobSpy();

    // mock body_md (codepoint 2000 字)
    const mockBody = ('## まとめ\n\n本書のまとめである。'.padEnd(2000, 'う')).slice(0, 2000);
    const mockOutput: WriterChapterOutput = {
      heading: 'まとめ — これからの一歩',
      body_md: mockBody,
      char_count: [...mockBody].length,
    };
    const mockGenerateChapter = async () => mockOutput;

    await runPipelineBookWriterChapter(
      {
        book_id: bookId,
        job_id: job4Id,
        outline_id: outlineId,
        chapter_index: 4,
      },
      addJobSpy.fn,
      { generateChapter: mockGenerateChapter },
    );

    // --- 検証 1: Chapter 4 行 upsert -----------------------------------------
    const chapter4 = await prisma.chapter.findFirst({
      where: { book_id: bookId, index: 4 },
    });
    expect(chapter4).not.toBeNull();
    expect(chapter4!.heading).toBe(mockOutput.heading);
    expect(chapter4!.body_md).toBe(mockOutput.body_md);
    expect(chapter4!.char_count).toBe(mockOutput.char_count);
    expect(chapter4!.status).toBe('done');

    // --- 検証 2: Chapter.count === 4 -----------------------------------------
    const afterChapterCount = await prisma.chapter.count({ where: { book_id: bookId } });
    expect(afterChapterCount).toBe(4);

    // --- 検証 3: editor Job 1 行 INSERT (parent_job_id=job4Id, status='queued') ---
    const editorJobs = await prisma.job.findMany({
      where: { book_id: bookId, kind: 'pipeline.book.editor' },
    });
    expect(editorJobs).toHaveLength(1);
    const editorJob = editorJobs[0]!;
    expect(editorJob.book_id).toBe(bookId);
    expect(editorJob.kind).toBe('pipeline.book.editor');
    expect(editorJob.parent_job_id).toBe(job4Id);
    expect(editorJob.status).toBe('queued');
    const editorPayload = editorJob.payload_json as { book_id: string };
    expect(editorPayload.book_id).toBe(bookId);

    // --- 検証 4: addJob spy が editor 1 回呼出 -------------------------------
    expect(addJobSpy.records).toHaveLength(1);
    const editorAddCall = addJobSpy.records[0]!;
    expect(editorAddCall.identifier).toBe('pipeline.book.editor');
    expect(editorAddCall.spec).toEqual({ maxAttempts: 3 });
    const callPayload = editorAddCall.payload as { book_id: string; job_id: string };
    expect(callPayload.book_id).toBe(bookId);
    expect(callPayload.job_id).toBe(editorJob.id);

    // --- 検証 5: chapter_index=4 Job result_json.{is_last, editor_job_id} ------
    const finalJob4 = await prisma.job.findUnique({ where: { id: job4Id } });
    expect(finalJob4!.status).toBe('done');
    const result4 = finalJob4!.result_json as {
      chapter_id: string;
      chapter_index: number;
      char_count: number;
      is_last: boolean;
      editor_job_id: string | null;
    };
    expect(result4.chapter_id).toBe(chapter4!.id);
    expect(result4.chapter_index).toBe(4);
    expect(result4.is_last).toBe(true);
    expect(result4.editor_job_id).toBe(editorJob.id);

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-05 chapter4 finalize] editor_job_id=${editorJob.id} ` +
        `(parent=${editorJob.parent_job_id}) chapter_count=${afterChapterCount}`,
    );
  });

  // ===========================================================================
  // Test 5 — 二重 enqueue ガード: 同じ最終章を再実行しても editor が増えない
  // ===========================================================================
  test('chapter_index=4 再実行 (mock LLM) → editor 二重 enqueue されない (existing guard)', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // 事前: editor Job は 1 行 (test 4 で作成済み)
    const beforeEditorJobs = await prisma.job.findMany({
      where: { book_id: bookId, kind: 'pipeline.book.editor' },
    });
    expect(beforeEditorJobs).toHaveLength(1);
    const existingEditorJobId = beforeEditorJobs[0]!.id;

    // chapter_index=4 Job を queued に戻す (再実行シミュレーション)。
    // result_json は worker 側 step 8 で上書きされるため触らない。
    const job4Id = childJobIdByIndex.get(4)!;
    await prisma.job.update({
      where: { id: job4Id },
      data: { status: 'queued', finished_at: null, error: null },
    });

    // 同じ mock 出力で再実行
    const mockBody = ('## まとめ (再実行)\n\n再実行版の本文。'.padEnd(2000, 'え')).slice(0, 2000);
    const mockOutput: WriterChapterOutput = {
      heading: 'まとめ — これからの一歩',
      body_md: mockBody,
      char_count: [...mockBody].length,
    };
    const mockGenerateChapter = async () => mockOutput;

    const addJobSpy = makeAddJobSpy();
    await runPipelineBookWriterChapter(
      {
        book_id: bookId,
        job_id: job4Id,
        outline_id: outlineId,
        chapter_index: 4,
      },
      addJobSpy.fn,
      { generateChapter: mockGenerateChapter },
    );

    // --- 検証 1: editor Job は依然 1 行 (二重 enqueue されない) ---------------
    const afterEditorJobs = await prisma.job.findMany({
      where: { book_id: bookId, kind: 'pipeline.book.editor' },
    });
    expect(afterEditorJobs).toHaveLength(1);
    expect(afterEditorJobs[0]!.id).toBe(existingEditorJobId);

    // --- 検証 2: addJob spy で editor は 0 回 (skip ログのみ) ------------------
    const editorAddCalls = addJobSpy.records.filter(
      (r) => r.identifier === 'pipeline.book.editor',
    );
    expect(editorAddCalls).toHaveLength(0);

    // --- 検証 3: chapter_index=4 Job は再 done、result_json.editor_job_id=null --
    // (二重 enqueue ガードで新規作成しなかったため editor_job_id は本回呼出では null)
    const finalJob4 = await prisma.job.findUnique({ where: { id: job4Id } });
    expect(finalJob4!.status).toBe('done');
    const result4 = finalJob4!.result_json as {
      is_last: boolean;
      editor_job_id: string | null;
    };
    expect(result4.is_last).toBe(true);
    expect(result4.editor_job_id).toBeNull();

    // --- 検証 4: Chapter 4 は再 upsert で body_md 上書き ---------------------
    const chapter4 = await prisma.chapter.findFirst({
      where: { book_id: bookId, index: 4 },
    });
    expect(chapter4!.body_md).toBe(mockOutput.body_md);
    expect(chapter4!.char_count).toBe(mockOutput.char_count);

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-05 chapter4 re-run] editor_jobs_count=${afterEditorJobs.length} ` +
        `(existing=${existingEditorJobId}) addJob_editor_calls=${editorAddCalls.length}`,
    );
  });
});
