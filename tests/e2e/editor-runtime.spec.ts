/**
 * Runtime verification spec for T-04-03 — Editor エージェント (全章統合校閲 + AI 開示文挿入)
 *
 * SP-04 段階では Editor を起動する worker / UI 経路はまだ配線されていないため、
 * 通常の Playwright (ブラウザ操作 → DOM 検証) では F-005 / R-05 を検証できない。
 * 代わりに以下を Node ランタイム上で直接呼び出して検証する:
 *
 *   1. 一時 Account → Book → Job 行を Prisma で作成
 *      (token_usage.book_id / job_id FK を満たす)
 *   2. 7 章分のダミー Writer chapter 出力 (heading + body_md ~800-1500 字) を構築
 *   3. editBook({ jobId, bookId, accountId, genre:'business', themeContext,
 *      chapters: [...7 章], aiDisclosureText, feedback: [] }) を実 LLM
 *      (editor assignment = anthropic claude-sonnet-4-6) で呼び出し
 *   4. 戻り値を検証 — F-005 / R-05 受入基準:
 *      - chapters.length === 入力章数 (7)
 *      - 各 chapter に index / heading / body_md (>=500 字)
 *      - index は入力と一致 (順序維持)
 *      - heading は入力と一致 (Editor が改変しない契約)
 *      - ai_disclosure_appended === true
 *      - 最終章 body_md (正規化) 末尾近傍に aiDisclosureText (正規化) が含まれる
 *      - ai_disclosure_text === 入力した文字列
 *   5. token_usage に role='editor', provider='anthropic', book_id=bookId,
 *      job_id=jobId で 1 行 INSERT を確認 (model は claude- prefix)
 *   6. クリーンアップ: 一時 TokenUsage + Job + Book + Account を deleteMany / delete
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner として
 *     借用し、@a2p/db / @a2p/agents/editor を直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と .env.local
 *     (ANTHROPIC_API_KEY 実値あり) が前提。
 *     ModelAssignment (role='editor', genre=null, provider='anthropic',
 *     model='claude-sonnet-4-6') + Prompt (role='editor', genre=null active) が
 *     seed 済であることも前提。
 *
 * コスト: claude-sonnet-4-6 全章 (7 章 × ~1000 字 = 7000 字) 校閲 1 呼出
 *         ≒ input ~4000 + output ~10000-14000 tokens (~$0.20-0.30, ~30-45 円)。
 *
 * 設計判断 (本 spec 固有):
 *  - 章数は **コスト抑制のため 7 章** (F-003 最小章数) で固定。
 *  - 各章 body_md は ~800 字程度 (zod 入力 min=500 を確実に上回り、かつ LLM 入力
 *    トークン量を抑えるバランス)。LLM 出力は zod min(500) の制約と合わせ、
 *    校閲後も 500 字以上を維持するはず。
 *  - retry 戦略は writer/outline / writer/chapter と同じ。
 *    editor.invalid_output / editor.chapters_mismatch は LLM 揺れで稀に起きるため
 *    最大 3 回 retry。前回失敗 token_usage を掃除して再試行。
 *  - AI 開示文未挿入時の強制挿入動作は **unit test (5/6) で mock 検証済**。
 *    実 LLM では大抵入れてくれるため、本 e2e では LLM が挿入する側の正常系のみ確認。
 *    呼出側の安全装置 (containsDisclosure → 強制挿入) は ai_disclosure_appended === true
 *    で実体保証されているので、本 spec では「最終章末尾近傍に aiDisclosureText が
 *    含まれる」を assert する形で間接的にカバーする。
 *  - 入力 chapters は filler 'あ' を使った最小ダミー。LLM は表記ゆれ修正のしようが
 *    限定的だが、F-005 受入基準 (章数/index 維持 + AI 開示文挿入) の検証には十分。
 *    Quality Judge (Phase 2) は別レイヤーで評価する。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { editBook } from '@a2p/agents/editor';
import { invalidateApiKeyCache } from '@a2p/agents/lib/get-api-key';

const SKIP_REAL_API = process.env.PLAYWRIGHT_SKIP_REAL_API === '1';

/** 指定文字数 (codepoint) の Markdown 本文を生成。Writer chapter 出力を模擬。 */
function buildDummyBody(chars: number, index: number): string {
  const header = `## 第${index}章の本文\n\n`;
  // 句点入り短文を繰り返して長文化。LLM が校閲しやすい (少しは表記ゆれ調整できる) ように
  // です・ます調と だ・である調を混在させる (校閲対象の素地)。
  const sentenceA = '本章では本書のテーマについて具体的に解説していきます。';
  const sentenceB = '読者は本章を通じて重要な視点を獲得することができるだろう。';
  let body = header;
  while ([...body].length < chars) {
    body += sentenceA + sentenceB + '\n\n';
  }
  return body;
}

/** 空白を圧縮した部分一致判定 (editor 本体の containsDisclosure と同等)。 */
function normalizedIncludes(haystack: string, needle: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, '');
  return norm(haystack).includes(norm(needle));
}

const AI_DISCLOSURE_TEXT =
  '本書は生成 AI を活用して執筆・編集されたコンテンツです。Amazon KDP のコンテンツガイドラインに従い、AI 生成コンテンツであることを明示します。';

const THEME_CONTEXT = {
  title: 'リモートワーク時代のチームマネジメント',
  hook: 'リモート/ハイブリッド環境で信頼ベースの組織を作る',
  target_reader: '中小企業〜大企業の課長・部長クラス',
};

const INPUT_CHAPTERS = [
  { index: 1, heading: '第1章 はじめに — 変化する働き方', body_md: buildDummyBody(800, 1) },
  { index: 2, heading: '第2章 信頼の土台を作る', body_md: buildDummyBody(800, 2) },
  { index: 3, heading: '第3章 1on1 の設計と実践', body_md: buildDummyBody(800, 3) },
  { index: 4, heading: '第4章 非同期コミュニケーション', body_md: buildDummyBody(800, 4) },
  { index: 5, heading: '第5章 評価と成長の支援', body_md: buildDummyBody(800, 5) },
  { index: 6, heading: '第6章 チーム文化の醸成', body_md: buildDummyBody(800, 6) },
  { index: 7, heading: '第7章 まとめ — これからの一歩', body_md: buildDummyBody(800, 7) },
];

test.describe('runtime: Editor editBook (T-04-03)', () => {
  // Anthropic claude-sonnet-4-6 で 7 章統合校閲 (input ~7000 字 + output ~7000-10000 字)。
  // 通常 60-180s 想定。LLM 応答揺れと再試行マージンも見て 600s 上限。
  test.setTimeout(600_000);

  let accountId: string;
  let bookId: string;
  let jobId: string;
  const createdTokenUsageIds: string[] = [];

  test.beforeAll(async () => {
    if (SKIP_REAL_API) return;
    invalidateApiKeyCache();

    // 1) 一時 Account
    const account = await prisma.account.create({
      data: {
        pen_name: `e2e-editor-${Date.now()}`,
        genre_policy_json: {
          primary_genre: 'business',
          ratio: { business: 1 },
          focus_themes: ['remote_work'],
        },
        status: 'archived',
      },
    });
    accountId = account.id;

    // 2) 一時 Book (token_usage.book_id FK 用)
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

    // 3) 一時 Job (token_usage.job_id FK 用)
    const job = await prisma.job.create({
      data: {
        kind: 't-04-03-runtime-test',
        book_id: bookId,
        payload_json: { source: 'e2e/editor-runtime.spec.ts' },
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
      await prisma.book.delete({ where: { id: bookId } }).catch(() => undefined);
    }
    if (accountId) {
      await prisma.account
        .delete({ where: { id: accountId } })
        .catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  test('editBook 実呼出 → 7 章校閲 + AI 開示文巻末挿入 + token_usage 1 行 (role=editor)', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // 事前: 当該 bookId / jobId に紐づく token_usage が無いことを確認
    const beforeCount = await prisma.tokenUsage.count({
      where: { OR: [{ book_id: bookId }, { job_id: jobId }] },
    });
    expect(beforeCount).toBe(0);

    // --- 実呼出 -----------------------------------------------------------
    // editor.invalid_output / editor.chapters_mismatch の LLM 揺れに備え最大 3 回 retry。
    const MAX_ATTEMPTS = 3;
    let result: Awaited<ReturnType<typeof editBook>> | null = null;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        result = await editBook({
          jobId,
          bookId,
          accountId,
          genre: 'business',
          themeContext: THEME_CONTEXT,
          chapters: INPUT_CHAPTERS,
          aiDisclosureText: AI_DISCLOSURE_TEXT,
          feedback: [],
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `[T-04-03 runtime] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`,
        );
        const details = (err as { details?: { rawText?: string } }).details;
        if (details?.rawText) {
          // eslint-disable-next-line no-console
          console.warn(
            `[T-04-03 attempt ${attempt}] rawText (first 2000 chars):\n${details.rawText.slice(0, 2000)}`,
          );
        }
        const isEditorAgentError = msg.startsWith('editor.');
        if (!isEditorAgentError) throw err;
        if (attempt === MAX_ATTEMPTS) break;
        // 前回失敗 token_usage を掃除して再試行
        await prisma.tokenUsage.deleteMany({
          where: { OR: [{ book_id: bookId }, { job_id: jobId }] },
        });
      }
    }
    if (lastErr || !result) {
      throw lastErr ?? new Error('editBook returned no result');
    }

    // --- 戻り値検証 (F-005 / R-05 受入基準) -------------------------------
    // デバッグ用: 校閲結果を一覧ログ (Playwright list reporter に出る)
    // eslint-disable-next-line no-console
    console.log(
      `[T-04-03 editor] chapters=${result.chapters.length} ` +
        `ai_disclosure_appended=${result.ai_disclosure_appended} ` +
        `ai_disclosure_text="${result.ai_disclosure_text.slice(0, 40)}..."`,
    );
    for (const c of result.chapters) {
      // eslint-disable-next-line no-console
      console.log(
        `[T-04-03 ch.${c.index}] "${c.heading}" body_md=${[...c.body_md].length}字 ` +
          `diff_summary=${c.diff_summary ? `"${c.diff_summary.slice(0, 60)}..."` : '(none)'}`,
      );
    }
    if (result.overall_notes) {
      // eslint-disable-next-line no-console
      console.log(
        `[T-04-03 overall_notes] "${result.overall_notes.slice(0, 200)}..."`,
      );
    }

    // 章数 = 入力と一致 (7)
    expect(result.chapters.length).toBe(INPUT_CHAPTERS.length);

    // 各章必須フィールド + index 順序 + heading 一致 + body_md 長
    for (let i = 0; i < result.chapters.length; i += 1) {
      const out = result.chapters[i]!;
      const inp = INPUT_CHAPTERS[i]!;
      // index 順序維持 (Editor が並び替えてはいけない)
      expect(out.index).toBe(inp.index);
      // heading は入力と完全一致 (Editor は章タイトルを改変しない契約)
      expect(out.heading).toBe(inp.heading);
      // body_md 500 字以上 (zod min(500) で強制済だが念のため codepoint で再確認)
      expect(typeof out.body_md).toBe('string');
      expect([...out.body_md].length).toBeGreaterThanOrEqual(500);
      // diff_summary は任意。あれば 2000 字以内。
      if (out.diff_summary !== undefined) {
        expect(typeof out.diff_summary).toBe('string');
        expect(out.diff_summary.length).toBeLessThanOrEqual(2000);
      }
    }

    // R-05 安全装置: ai_disclosure_appended === true
    expect(result.ai_disclosure_appended).toBe(true);

    // ai_disclosure_text は入力した文字列 (trim 等価) と一致
    expect(result.ai_disclosure_text).toBe(AI_DISCLOSURE_TEXT.trim());

    // 最終章 body_md に AI 開示文 (正規化部分一致) が含まれる
    // LLM が挿入していれば自然に含まれ、忘れていたら editor.ts L196-214 の強制挿入で
    // 末尾に追加され、いずれにせよ true で返る契約。
    const lastChapter = result.chapters[result.chapters.length - 1]!;
    expect(normalizedIncludes(lastChapter.body_md, AI_DISCLOSURE_TEXT)).toBe(true);

    // overall_notes は任意。あれば 2000 字以内。
    if (result.overall_notes !== undefined) {
      expect(typeof result.overall_notes).toBe('string');
      expect(result.overall_notes.length).toBeLessThanOrEqual(2000);
    }

    // --- token_usage 検証 -------------------------------------------------
    const rows = await prisma.tokenUsage.findMany({
      where: { job_id: jobId, role: 'editor' },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    createdTokenUsageIds.push(row.id);

    expect(row.provider).toBe('anthropic');
    expect(row.role).toBe('editor');
    expect(row.book_id).toBe(bookId);
    expect(row.job_id).toBe(jobId);
    expect(row.theme_session_id).toBeNull();

    // model は ModelAssignment 経由で editor assignment (claude-sonnet-4-6) が選択される。
    // 将来 opus に切り替わってもテストが落ちないよう "claude-" prefix で寛容に判定。
    expect(row.model).toMatch(/^claude-/);

    // input_tokens — system prompt + user message (7 章本文 JSON 埋め込み) で
    // 数千 token 想定 (> 1000)
    expect(row.input_tokens).toBeGreaterThan(1000);
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
      `[T-04-03 token_usage] model=${row.model} input=${row.input_tokens} ` +
        `output=${row.output_tokens} cached=${row.cached_input_tokens} ` +
        `cost_jpy=${row.cost_jpy.toString()}`,
    );
  });
});
