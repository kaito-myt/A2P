/**
 * Runtime verification spec for T-04-01 — Writer エージェント (アウトライン生成)
 *
 * SP-04 段階では Writer を起動する worker / UI 経路はまだ配線されていないため、
 * 通常の Playwright (ブラウザ操作 → DOM 検証) では F-003 を検証できない。
 * 代わりに以下を Node ランタイム上で直接呼び出して検証する:
 *
 *   1. 一時 Account → Book → Job 行を Prisma で作成
 *      (token_usage.book_id / job_id FK を満たす)
 *   2. generateOutline({ jobId, bookId, accountId, genre:'business', themeContext,
 *      targetChapterCount:8, targetTotalChars:50000 }) を実 LLM (writer assignment =
 *      anthropic claude-sonnet-4-6) で呼び出し
 *   3. 戻り値 (chapters[], totalCharsEstimate) を検証 — F-003 受入基準:
 *      - chapters.length が 7〜10 (zod 強制済 + 実値で再確認)
 *      - 各章 index は 1 始まり連番 (1, 2, ..., N)
 *      - 各章に heading / summary / target_chars / subheadings (>= 2)
 *      - target_chars の合計が targetTotalChars (50000) の ±15% (42,500〜57,500)
 *   4. token_usage に role='writer', provider='anthropic', book_id=bookId,
 *      job_id=jobId で 1 行 INSERT を確認
 *   5. クリーンアップ: 一時 TokenUsage + Job + Book + Account を deleteMany / delete
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner として
 *     借用し、@a2p/db / @a2p/agents/writer/outline を直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と .env.local
 *     (ANTHROPIC_API_KEY 実値あり) が前提。
 *     ModelAssignment (role='writer', genre=null, provider='anthropic',
 *     model='claude-sonnet-4-6') + Prompt (role='writer', genre=null active) が
 *     seed 済であることも前提。
 *
 * モデル選択メモ:
 *  - 現行 seed では Writer は `claude-sonnet-4-6` が選択される (packages/db/seed.ts
 *    L212)。タスク Spec の「通常 claude-opus-4-7」は将来差し替え可能性を示唆して
 *    いるだけで、現状アサインに合わせて sonnet を期待値とする。
 *  - Writer は web_search 不要 (Marketer と異なる) → AISdkClient 経路。
 *
 * コスト: claude-sonnet-4-6 アウトライン 1 呼出 ≒ input 1500-3000 + output 2000-5000
 *         tokens (~$0.03-0.07, ~5-10 円)。Marketer より小さい。
 *
 * 設計判断 (本 spec 固有):
 *  - prompts table の Writer プロンプトは seed 段階では placeholder 形式 (T-04-01
 *    task spec 注記)。実装側 (outline.ts buildUserMessage) で詳細補完 (出力 JSON
 *    形式 + F-003 制約) を行うため、placeholder のままでも構造化 JSON は返る前提。
 *  - 評価軸はあくまで「F-003 制約を守った JSON が返ってくる + token_usage 1 行記録」。
 *    内容の品質 (各章の魅力度等) は Quality Judge (Phase 2) で評価する。
 *  - book FK 用に Book 行を作る (marketer/metadata の book_id=null 構成と異なる
 *    Writer 特有の前提)。Book には prompt_version_ids_json / model_assignment_snapshot
 *    が required なので、最小ダミー JSON を投入する。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { generateOutline } from '@a2p/agents/writer/outline';
import { invalidateApiKeyCache } from '@a2p/agents/lib/get-api-key';

const SKIP_REAL_API = process.env.PLAYWRIGHT_SKIP_REAL_API === '1';

test.describe('runtime: Writer generateOutline (T-04-01)', () => {
  // Anthropic claude-sonnet-4-6 で 8 章分の構造化 JSON 生成 + DB I/O。
  // 通常 30-90s 想定。LLM の応答揺れと再試行マージンも見て 300s 上限。
  test.setTimeout(300_000);

  let accountId: string;
  let bookId: string;
  let jobId: string;
  const createdTokenUsageIds: string[] = [];

  test.beforeAll(async () => {
    if (SKIP_REAL_API) return;
    invalidateApiKeyCache();

    // 1) 一時 Account を作成
    const account = await prisma.account.create({
      data: {
        pen_name: `e2e-writer-outline-${Date.now()}`,
        genre_policy_json: {
          primary_genre: 'business',
          ratio: { business: 1 },
          focus_themes: ['remote_work'],
        },
        status: 'archived',
      },
    });
    accountId = account.id;

    // 2) 一時 Book を作成 (token_usage.book_id FK 用)
    //    prompt_version_ids_json / model_assignment_snapshot は schema 上 required。
    //    Writer 起動時点の active snapshot を真似て最小値で埋める。
    const book = await prisma.book.create({
      data: {
        account_id: accountId,
        title: 'E2E: リモートワーク時代のチームマネジメント',
        status: 'running',
        prompt_version_ids_json: {},
        model_assignment_snapshot: {},
      },
    });
    bookId = book.id;

    // 3) 一時 Job を作成 (token_usage.job_id FK 用)
    const job = await prisma.job.create({
      data: {
        kind: 't-04-01-runtime-test',
        book_id: bookId,
        payload_json: { source: 'e2e/writer-outline-runtime.spec.ts' },
      },
    });
    jobId = job.id;
  });

  test.afterAll(async () => {
    if (SKIP_REAL_API) return;

    // クリーンアップ: 本テストで生成した token_usage 行を確実に消す
    if (bookId) {
      await prisma.tokenUsage
        .deleteMany({ where: { book_id: bookId } })
        .catch(() => undefined);
    }
    if (jobId) {
      await prisma.tokenUsage
        .deleteMany({ where: { job_id: jobId } })
        .catch(() => undefined);
    }
    if (createdTokenUsageIds.length > 0) {
      await prisma.tokenUsage
        .deleteMany({ where: { id: { in: createdTokenUsageIds } } })
        .catch(() => undefined);
    }

    if (jobId) {
      await prisma.job.delete({ where: { id: jobId } }).catch(() => undefined);
    }
    if (bookId) {
      // Book 削除で関連 Outline 等は cascade される (schema.prisma 参照)。
      await prisma.book.delete({ where: { id: bookId } }).catch(() => undefined);
    }
    if (accountId) {
      // Account cascade で残存 Book / theme_candidates 等も掃除される。
      await prisma.account
        .delete({ where: { id: accountId } })
        .catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  test('generateOutline 実呼出 → 7〜10 章アウトライン + token_usage 1 行 (role=writer)', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // 事前: 当該 bookId / jobId に紐づく token_usage が無いことを確認
    const beforeCount = await prisma.tokenUsage.count({
      where: { OR: [{ book_id: bookId }, { job_id: jobId }] },
    });
    expect(beforeCount).toBe(0);

    // --- 実呼出 -----------------------------------------------------------
    // 既知の LLM 出力揺れ (writer.outline.invalid_output / chars_out_of_range) に
    // 備え最大 3 回 retry。各 retry の前に前回失敗で残った token_usage を掃除する。
    // (Marketer theme spec と同パターン)
    const MAX_ATTEMPTS = 3;
    let result: Awaited<ReturnType<typeof generateOutline>> | null = null;
    let lastErr: unknown = null;
    const targetTotalChars = 50000;
    const targetChapterCount = 8;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        result = await generateOutline({
          jobId,
          bookId,
          accountId,
          genre: 'business',
          themeContext: {
            title: 'リモートワーク時代のチームマネジメント',
            hook: 'リモート/ハイブリッド環境で信頼ベースの組織を作る',
            target_reader: '中小企業〜大企業の課長・部長クラス',
          },
          targetChapterCount,
          targetTotalChars,
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `[T-04-01 runtime] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`,
        );
        const details = (err as { details?: { rawText?: string } }).details;
        if (details?.rawText) {
          // eslint-disable-next-line no-console
          console.warn(
            `[T-04-01 attempt ${attempt}] rawText (first 2000 chars):\n${details.rawText.slice(0, 2000)}`,
          );
        }
        const isWriterAgentError = msg.startsWith('writer.outline.');
        if (!isWriterAgentError) throw err;
        if (attempt === MAX_ATTEMPTS) break;
        await prisma.tokenUsage.deleteMany({
          where: { OR: [{ book_id: bookId }, { job_id: jobId }] },
        });
      }
    }
    if (lastErr || !result) {
      throw lastErr ?? new Error('generateOutline returned no result');
    }

    // --- 戻り値検証 (F-003 受入基準) ----------------------------------------
    // デバッグ用: 生成 chapters を一覧ログ (Playwright list reporter に出る)
    // eslint-disable-next-line no-console
    console.log(
      `[T-04-01 outline] chapters=${result.chapters.length} ` +
        `totalCharsEstimate=${result.totalCharsEstimate}`,
    );
    for (const c of result.chapters) {
      // eslint-disable-next-line no-console
      console.log(
        `[T-04-01 ch.${c.index}] "${c.heading}" target_chars=${c.target_chars} subheadings=${c.subheadings.length} summary=${c.summary.slice(0, 40)}...`,
      );
    }

    // 章数 7〜10
    expect(result.chapters.length).toBeGreaterThanOrEqual(7);
    expect(result.chapters.length).toBeLessThanOrEqual(10);

    // 各章必須フィールド + index 連番
    for (let i = 0; i < result.chapters.length; i += 1) {
      const c = result.chapters[i]!;
      expect(c.index).toBe(i + 1);
      expect(typeof c.heading).toBe('string');
      expect(c.heading.length).toBeGreaterThan(0);
      expect(c.heading.length).toBeLessThanOrEqual(200);
      expect(typeof c.summary).toBe('string');
      expect(c.summary.length).toBeGreaterThan(0);
      expect(c.summary.length).toBeLessThanOrEqual(800);
      expect(Number.isInteger(c.target_chars)).toBe(true);
      expect(c.target_chars).toBeGreaterThanOrEqual(2000);
      expect(c.target_chars).toBeLessThanOrEqual(15000);
      expect(Array.isArray(c.subheadings)).toBe(true);
      expect(c.subheadings.length).toBeGreaterThanOrEqual(2);
      expect(c.subheadings.length).toBeLessThanOrEqual(10);
      for (const sh of c.subheadings) {
        expect(typeof sh).toBe('string');
        expect(sh.length).toBeGreaterThan(0);
      }
    }

    // 文字数合計 ±15% (50000 → 42,500〜57,500)
    const sum = result.chapters.reduce((acc, c) => acc + c.target_chars, 0);
    expect(sum).toBe(result.totalCharsEstimate); // outline.ts が再計算した値と一致
    const minTotal = Math.floor(targetTotalChars * 0.85);
    const maxTotal = Math.ceil(targetTotalChars * 1.15);
    expect(sum).toBeGreaterThanOrEqual(minTotal);
    expect(sum).toBeLessThanOrEqual(maxTotal);

    // --- token_usage 検証 -------------------------------------------------
    const rows = await prisma.tokenUsage.findMany({
      where: { book_id: bookId, role: 'writer' },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    createdTokenUsageIds.push(row.id);

    expect(row.provider).toBe('anthropic');
    expect(row.role).toBe('writer');
    expect(row.book_id).toBe(bookId);
    expect(row.job_id).toBe(jobId);
    expect(row.theme_session_id).toBeNull();

    // model は ModelAssignment 経由で writer assignment (claude-sonnet-4-6) が選択される。
    // 将来 opus に切り替わってもテストが落ちないよう "claude-" prefix で寛容に判定。
    expect(row.model).toMatch(/^claude-/);

    // input_tokens — system prompt + user message で数百〜数千 token 想定 (> 100)
    expect(row.input_tokens).toBeGreaterThan(100);
    expect(row.output_tokens).toBeGreaterThan(0);
    expect(row.image_count).toBe(0);

    // unit_price_snapshot — model_catalog 未 seed なら {} / seed 済なら snapshot
    expect(row.unit_price_snapshot).toBeDefined();
    const snapshot = row.unit_price_snapshot as Record<string, unknown>;
    if (Object.keys(snapshot).length === 0) {
      expect(Number(row.cost_jpy)).toBe(0);
    } else {
      expect(Number(row.cost_jpy)).toBeGreaterThan(0);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-01 token_usage] model=${row.model} input=${row.input_tokens} ` +
        `output=${row.output_tokens} cached=${row.cached_input_tokens} ` +
        `cost_jpy=${row.cost_jpy.toString()}`,
    );
  });
});
