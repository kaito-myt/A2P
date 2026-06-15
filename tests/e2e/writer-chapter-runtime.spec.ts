/**
 * Runtime verification spec for T-04-02 — Writer エージェント (章本文執筆)
 *
 * SP-04 段階では Writer chapter を起動する worker / UI 経路はまだ配線されていないため、
 * 通常の Playwright (ブラウザ操作 → DOM 検証) では F-004 / F-050 を検証できない。
 * 代わりに以下を Node ランタイム上で直接呼び出して検証する:
 *
 *   1. 一時 Account → Book → Job 行を Prisma で作成
 *      (token_usage.book_id / job_id FK を満たす)
 *   2. generateChapter({ jobId, bookId, accountId, genre:'business',
 *      outlineChapter:{ index:1, heading:'はじめに', summary:'...', target_chars:5000,
 *      subheadings:['背景','本書の構成'] }, themeContext:{...} }) を実 LLM
 *      (writer assignment = anthropic claude-sonnet-4-6) で呼び出し
 *   3. 戻り値 (heading, body_md, char_count) を検証 — F-004 受入基準:
 *      - body_md 非空、Markdown heading (`#`) を含む
 *      - char_count = [...body_md].length (codepoint 数で再計算した値と一致)
 *      - char_count が target_chars の ±20% 範囲内 (5000 → 4000〜6000)
 *      - heading は outlineChapter.heading echo or LLM 補完値 (string)
 *   4. token_usage に role='writer', provider='anthropic', book_id=bookId,
 *      job_id=jobId で 1 行 INSERT を確認 (model は claude- prefix)
 *   5. (オプション) feedback 注入版: 同 spec 内で must=「本章の冒頭で
 *      『信頼ベース』というキーワードを必ず使用すること」を指示し、再生成された
 *      body_md にキーワードが含まれることを確認 (形式チェックのみ、品質は緩く OK)
 *   6. クリーンアップ: 一時 TokenUsage + Job + Book + Account を deleteMany / delete
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner として
 *     借用し、@a2p/db / @a2p/agents/writer/chapter を直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と .env.local
 *     (ANTHROPIC_API_KEY 実値あり) が前提。
 *     ModelAssignment (role='writer', genre=null, provider='anthropic',
 *     model='claude-sonnet-4-6') + Prompt (role='writer', genre=null active) が
 *     seed 済であることも前提。
 *
 * コスト: claude-sonnet-4-6 章執筆 1 呼出 ≒ input ~2000 + output ~6000-8000
 *         tokens (~$0.05-0.10, ~7-15 円)。本 spec は 2 ケース実行 (デフォルト +
 *         feedback 注入) → 合計 ~$0.10-0.20 想定。
 *
 * 設計判断 (本 spec 固有):
 *  - retry 戦略は writer-outline-runtime と同じ。writer.chapter.invalid_output と
 *    writer.chapter.chars_out_of_range は LLM 揺れで稀に起きるため最大 3 回 retry。
 *  - target_chars=5000 を採用 (T-04-01 outline 平均的な章サイズ ~6000 字より小さく
 *    出力時間/コストを抑える)。±20% で 4000〜6000 字。
 *  - feedback 注入テストの可読性のため、独立した test ケース内で別 jobId を採番。
 *    book は共有しても問題ない (token_usage.book_id で集約可能)。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { generateChapter } from '@a2p/agents/writer/chapter';
import { invalidateApiKeyCache } from '@a2p/agents/lib/get-api-key';

const SKIP_REAL_API = process.env.PLAYWRIGHT_SKIP_REAL_API === '1';

test.describe('runtime: Writer generateChapter (T-04-02)', () => {
  // Anthropic claude-sonnet-4-6 で 1 章 ~5000 字の本文生成 + DB I/O。
  // 通常 30-90s 想定。LLM 応答揺れと再試行マージンも見て 600s 上限 (2 ケース合計)。
  test.setTimeout(600_000);

  let accountId: string;
  let bookId: string;
  let jobId: string;
  let jobIdFeedback: string;
  const createdTokenUsageIds: string[] = [];

  test.beforeAll(async () => {
    if (SKIP_REAL_API) return;
    invalidateApiKeyCache();

    // 1) 一時 Account
    const account = await prisma.account.create({
      data: {
        pen_name: `e2e-writer-chapter-${Date.now()}`,
        genre_policy_json: {
          primary_genre: 'business',
          ratio: { business: 1 },
          focus_themes: ['remote_work'],
        },
        status: 'archived',
      },
    });
    accountId = account.id;

    // 2) 一時 Book
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

    // 3) 一時 Job (デフォルト executionの ハッピーパス用)
    const job = await prisma.job.create({
      data: {
        kind: 't-04-02-runtime-test',
        book_id: bookId,
        payload_json: { source: 'e2e/writer-chapter-runtime.spec.ts', case: 'default' },
      },
    });
    jobId = job.id;

    // 4) 一時 Job (feedback 注入版用 — 別 jobId にすることで token_usage の集計が容易)
    const jobFeedback = await prisma.job.create({
      data: {
        kind: 't-04-02-runtime-test',
        book_id: bookId,
        payload_json: { source: 'e2e/writer-chapter-runtime.spec.ts', case: 'feedback' },
      },
    });
    jobIdFeedback = jobFeedback.id;
  });

  test.afterAll(async () => {
    if (SKIP_REAL_API) return;

    // クリーンアップ: 本テストで生成した token_usage 行を確実に消す
    if (bookId) {
      await prisma.tokenUsage
        .deleteMany({ where: { book_id: bookId } })
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
    if (jobIdFeedback) {
      await prisma.job.delete({ where: { id: jobIdFeedback } }).catch(() => undefined);
    }
    if (bookId) {
      await prisma.book.delete({ where: { id: bookId } }).catch(() => undefined);
    }
    if (accountId) {
      await prisma.account.delete({ where: { id: accountId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  test('generateChapter 実呼出 → 4000〜6000 字本文 (±20%) + token_usage 1 行 (role=writer)', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // 事前: 当該 jobId に紐づく token_usage が無いことを確認
    const beforeCount = await prisma.tokenUsage.count({
      where: { job_id: jobId },
    });
    expect(beforeCount).toBe(0);

    const targetChars = 5000;
    const minChars = Math.floor(targetChars * 0.8); // 4000
    const maxChars = Math.ceil(targetChars * 1.2);  // 6000

    // --- 実呼出 ----------------------------------------------------------
    // writer.chapter.invalid_output / chars_out_of_range の LLM 揺れに備え最大 3 回 retry。
    const MAX_ATTEMPTS = 3;
    let result: Awaited<ReturnType<typeof generateChapter>> | null = null;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        result = await generateChapter({
          jobId,
          bookId,
          accountId,
          genre: 'business',
          outlineChapter: {
            index: 1,
            heading: 'はじめに',
            summary: 'リモートワーク時代に変わるマネジメントの本質を導入する',
            target_chars: targetChars,
            subheadings: ['背景', '本書の構成'],
          },
          themeContext: {
            title: 'リモートワーク時代のチームマネジメント',
            hook: 'リモート/ハイブリッド環境で信頼ベースの組織を作る',
            target_reader: '中小企業〜大企業の課長・部長クラス',
          },
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `[T-04-02 runtime default] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`,
        );
        const details = (err as { details?: { rawText?: string } }).details;
        if (details?.rawText) {
          // eslint-disable-next-line no-console
          console.warn(
            `[T-04-02 default attempt ${attempt}] rawText (first 2000 chars):\n${details.rawText.slice(0, 2000)}`,
          );
        }
        const isWriterAgentError = msg.startsWith('writer.chapter.');
        if (!isWriterAgentError) throw err;
        if (attempt === MAX_ATTEMPTS) break;
        // 前回失敗 token_usage を掃除して再試行
        await prisma.tokenUsage.deleteMany({ where: { job_id: jobId } });
      }
    }
    if (lastErr || !result) {
      throw lastErr ?? new Error('generateChapter returned no result');
    }

    // --- 戻り値検証 (F-004 受入基準) -----------------------------------
    expect(typeof result.heading).toBe('string');
    expect(result.heading.length).toBeGreaterThan(0);

    expect(typeof result.body_md).toBe('string');
    expect(result.body_md.length).toBeGreaterThan(0);

    // body_md は Markdown 見出し (`#` or `##`) を含むこと
    expect(result.body_md).toMatch(/^#{1,3} /m);

    // char_count = [...body_md].length (codepoint, surrogate pair 安全)
    const codepoints = [...result.body_md].length;
    expect(result.char_count).toBe(codepoints);

    // ±20% 範囲内 (target=5000 → 4000〜6000)
    expect(result.char_count).toBeGreaterThanOrEqual(minChars);
    expect(result.char_count).toBeLessThanOrEqual(maxChars);

    // デバッグ用ログ (Playwright list reporter に出る)
    // eslint-disable-next-line no-console
    console.log(
      `[T-04-02 default] heading="${result.heading}" char_count=${result.char_count} ` +
        `(target=${targetChars} range=${minChars}-${maxChars})`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[T-04-02 default] body_md preview (first 300 chars):\n${result.body_md.slice(0, 300)}`,
    );

    // --- token_usage 検証 -------------------------------------------
    const rows = await prisma.tokenUsage.findMany({
      where: { job_id: jobId, role: 'writer' },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    createdTokenUsageIds.push(row.id);

    expect(row.provider).toBe('anthropic');
    expect(row.role).toBe('writer');
    expect(row.book_id).toBe(bookId);
    expect(row.job_id).toBe(jobId);
    expect(row.theme_session_id).toBeNull();

    // model は ModelAssignment 経由で writer assignment (claude-sonnet-4-6) が選択される
    expect(row.model).toMatch(/^claude-/);

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
      `[T-04-02 default token_usage] model=${row.model} input=${row.input_tokens} ` +
        `output=${row.output_tokens} cached=${row.cached_input_tokens} ` +
        `cost_jpy=${row.cost_jpy.toString()}`,
    );
  });

  test('generateChapter feedback 注入 → must コメントの内容が body_md に反映', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    const beforeCount = await prisma.tokenUsage.count({
      where: { job_id: jobIdFeedback },
    });
    expect(beforeCount).toBe(0);

    const targetChars = 5000;
    const minChars = Math.floor(targetChars * 0.8);
    const maxChars = Math.ceil(targetChars * 1.2);

    // 形式チェックに使うキーワード — LLM が必ず再現できる短く具体的なフレーズを選ぶ
    const MUST_KEYWORD = '信頼ベース';

    const MAX_ATTEMPTS = 3;
    let result: Awaited<ReturnType<typeof generateChapter>> | null = null;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        result = await generateChapter({
          jobId: jobIdFeedback,
          bookId,
          accountId,
          genre: 'business',
          outlineChapter: {
            index: 1,
            heading: 'はじめに',
            summary: 'リモートワーク時代に変わるマネジメントの本質を導入する',
            target_chars: targetChars,
            subheadings: ['背景', '本書の構成'],
          },
          themeContext: {
            title: 'リモートワーク時代のチームマネジメント',
            hook: 'リモート/ハイブリッド環境で信頼ベースの組織を作る',
            target_reader: '中小企業〜大企業の課長・部長クラス',
          },
          feedback: [
            {
              priority: 'must',
              body: `本章の冒頭または導入部で「${MUST_KEYWORD}」というキーワードを必ず使用してください。`,
            },
            {
              priority: 'should',
              body: '具体的な実例を 1 つ以上含めてください。',
            },
          ],
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `[T-04-02 runtime feedback] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`,
        );
        const details = (err as { details?: { rawText?: string } }).details;
        if (details?.rawText) {
          // eslint-disable-next-line no-console
          console.warn(
            `[T-04-02 feedback attempt ${attempt}] rawText (first 2000 chars):\n${details.rawText.slice(0, 2000)}`,
          );
        }
        const isWriterAgentError = msg.startsWith('writer.chapter.');
        if (!isWriterAgentError) throw err;
        if (attempt === MAX_ATTEMPTS) break;
        await prisma.tokenUsage.deleteMany({ where: { job_id: jobIdFeedback } });
      }
    }
    if (lastErr || !result) {
      throw lastErr ?? new Error('generateChapter returned no result');
    }

    // --- 戻り値検証 (形式 + feedback 反映) ---------------------------
    expect(typeof result.body_md).toBe('string');
    expect(result.body_md.length).toBeGreaterThan(0);
    expect(result.body_md).toMatch(/^#{1,3} /m);

    const codepoints = [...result.body_md].length;
    expect(result.char_count).toBe(codepoints);

    expect(result.char_count).toBeGreaterThanOrEqual(minChars);
    expect(result.char_count).toBeLessThanOrEqual(maxChars);

    // feedback 反映確認 (must キーワードが body_md 内に含まれること)
    // 品質判定は緩く、形式的にキーワードが現れたら OK とする (Quality Judge は別レイヤー)
    expect(result.body_md).toContain(MUST_KEYWORD);

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-02 feedback] heading="${result.heading}" char_count=${result.char_count} ` +
        `must_keyword="${MUST_KEYWORD}" included=${result.body_md.includes(MUST_KEYWORD)}`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[T-04-02 feedback] body_md preview (first 300 chars):\n${result.body_md.slice(0, 300)}`,
    );

    // --- token_usage 検証 -------------------------------------------
    const rows = await prisma.tokenUsage.findMany({
      where: { job_id: jobIdFeedback, role: 'writer' },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    createdTokenUsageIds.push(row.id);

    expect(row.provider).toBe('anthropic');
    expect(row.role).toBe('writer');
    expect(row.book_id).toBe(bookId);
    expect(row.job_id).toBe(jobIdFeedback);
    expect(row.model).toMatch(/^claude-/);

    // feedback あり版は input_tokens が default 版より大きいはず (sanity check, ただし厳密値は LLM 依存)
    expect(row.input_tokens).toBeGreaterThan(100);
    expect(row.output_tokens).toBeGreaterThan(0);

    // eslint-disable-next-line no-console
    console.log(
      `[T-04-02 feedback token_usage] model=${row.model} input=${row.input_tokens} ` +
        `output=${row.output_tokens} cost_jpy=${row.cost_jpy.toString()}`,
    );
  });
});
