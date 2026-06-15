/**
 * Runtime verification spec for T-03-02 — Marketer エージェント (KDP メタデータ生成)
 *
 * SP-03 段階では Marketer の KDP メタデータ生成パイプ (T-03-04 worker 統合) は
 * まだ配線されていないため、通常の Playwright (ブラウザ操作 → DOM 検証) では F-040
 * を検証できない。代わりに以下を Node ランタイム上で直接呼び出して検証する:
 *
 *   1. 一時 Account → Job 行を Prisma で作成 (token_usage.job_id FK 違反回避)
 *      theme_session_id は FK 制約を持たない自由テキストなので任意の値で OK
 *   2. generateMarketerMetadata({ themeContext: T-03-01 採用テーマ相当, ... })
 *      を Anthropic claude-opus-4-7 (Marketer assignment) で実呼出
 *   3. 戻り値 (metadata) を検証 — F-040 受入基準:
 *      - description 50〜4000 字 (zod 強制済 + 実 LLM 出力で再確認)
 *      - keywords 1〜7 個 / categories.length === 2 / suggested_price_jpy >= 99
 *   4. token_usage に role='marketer', provider='anthropic',
 *      theme_session_id 紐付け, job_id=jobId で 1 行 INSERT を確認
 *   5. クリーンアップ: 一時 TokenUsage + Job + Account を deleteMany
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner として
 *     借用し、@a2p/db / @a2p/agents/marketer/metadata を直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と
 *     .env.local (ANTHROPIC_API_KEY 実値あり) が前提。
 *     ModelAssignment (marketer, anthropic, claude-opus-4-7) + Prompt
 *     (role='marketer', genre=null active) が seed 済であることも前提。
 *
 * コスト: claude-opus-4-7 metadata 1 呼出 ≒ $0.05-0.10 / run (~7-15 円)
 *         theme.ts と異なり web_search は基本起動しない (metadata は採用テーマから
 *         派生するだけなので外部リサーチ不要) ため theme より安価。
 *
 * 設計判断 (本 spec 固有):
 *  - themeContext.title/subtitle/hook/target_reader は T-03-01 のサンプル結果を投入。
 *    具体的には「リモートワーク時代のチームマネジメント実践ガイド」(business genre)。
 *  - prompts table の Marketer プロンプトは seed placeholder 形式。実装 (metadata.ts)
 *    は {title}/{subtitle}/{hook}/{target_reader}/{competitors}/{genre} のみ差し込み、
 *    未知のプレースホルダはそのまま残る。buildUserMessage で KDP 制約 + JSON 出力形式
 *    を明示しているので、placeholder プロンプトでも構造化 JSON は返ってくる前提。
 *  - 評価軸はあくまで「KDP 制約を守った JSON が返ってくる + token_usage 1 行記録」。
 *    内容の品質 (description の魅力度等) は Quality Judge (Phase 2) で評価する。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { generateMarketerMetadata } from '@a2p/agents/marketer/metadata';
import { invalidateApiKeyCache } from '@a2p/agents/lib/get-api-key';

const SKIP_REAL_API = process.env.PLAYWRIGHT_SKIP_REAL_API === '1';
const TEST_TAG = 't-03-02-runtime-test';

test.describe('runtime: Marketer generateMarketerMetadata (T-03-02)', () => {
  // Anthropic + 構造化 JSON 生成 + DB I/O。
  // claude-opus-4-7 の応答 (description 50〜4000 字含む) で 30-90s 程度を想定。
  // theme.ts より短いがマージンを確保。
  test.setTimeout(300_000);

  let accountId: string;
  let jobId: string;
  let themeSessionId: string;
  const createdTokenUsageIds: string[] = [];

  test.beforeAll(async () => {
    if (SKIP_REAL_API) return;
    invalidateApiKeyCache();

    // 1) 一時 Account を作成 (status='archived' でダッシュボードに出さない)
    const account = await prisma.account.create({
      data: {
        pen_name: `e2e-marketer-meta-${Date.now()}`,
        genre_policy_json: {
          primary_genre: 'business',
          ratio: { business: 1 },
          focus_themes: ['remote_work'],
        },
        status: 'archived',
      },
    });
    accountId = account.id;

    // 2) 一時 Job を作成 (token_usage.job_id FK 用)
    const job = await prisma.job.create({
      data: {
        kind: 't-03-02-runtime-test',
        payload_json: { source: 'e2e/marketer-metadata-runtime.spec.ts' },
      },
    });
    jobId = job.id;

    // 3) theme_session_id は FK 制約無しの自由テキスト
    themeSessionId = `${TEST_TAG}-session-${Date.now()}`;
  });

  test.afterAll(async () => {
    if (SKIP_REAL_API) return;

    // クリーンアップ: 本テストで生成した token_usage 行を確実に消す
    if (themeSessionId) {
      await prisma.tokenUsage
        .deleteMany({ where: { theme_session_id: themeSessionId } })
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
    if (accountId) {
      await prisma.account
        .delete({ where: { id: accountId } })
        .catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  test('generateMarketerMetadata 実呼出 → KDP 制約遵守 metadata + token_usage 1 行 (role=marketer)', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // 事前: 当該 themeSessionId / jobId に紐づく token_usage が無いことを確認
    const beforeCount = await prisma.tokenUsage.count({
      where: {
        OR: [{ theme_session_id: themeSessionId }, { job_id: jobId }],
      },
    });
    expect(beforeCount).toBe(0);

    // --- 実呼出 -----------------------------------------------------------
    // T-03-01 で生成された (想定) サンプル theme を投入。
    const result = await generateMarketerMetadata({
      themeSessionId,
      jobId,
      accountId,
      genre: 'business',
      themeContext: {
        title: 'リモートワーク時代のチームマネジメント実践ガイド',
        subtitle: '心理的安全性と成果を両立する 5 つのフレームワーク',
        hook:
          'リモート/ハイブリッド環境で信頼ベースの組織を作るための実務マニュアル',
        target_reader: '中小企業〜大企業の課長・部長クラス（30〜50歳）',
        competitors: [],
        signals: {},
      },
    });

    // --- 戻り値検証 (F-040 受入基準) ----------------------------------------
    const meta = result.metadata;

    // デバッグ用: 生成結果の主要部分をログ出力 (list reporter に出る)
    // eslint-disable-next-line no-console
    console.log(
      `[T-03-02 metadata] description.length=${meta.description.length} ` +
        `keywords=[${meta.keywords.join(', ')}] ` +
        `categories=${meta.categories.length} ` +
        `price=${meta.suggested_price_jpy}`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[T-03-02 metadata.description]\n${meta.description.slice(0, 200)}...`,
    );
    // eslint-disable-next-line no-console
    console.log(`[T-03-02 metadata.categories] ${JSON.stringify(meta.categories)}`);

    // description: 50〜4000 字 (zod で強制済だが実値で再確認 — task spec 明示要件)
    expect(meta.description.length).toBeGreaterThanOrEqual(50);
    expect(meta.description.length).toBeLessThanOrEqual(4000);

    // keywords: 1〜7 個
    expect(meta.keywords.length).toBeGreaterThanOrEqual(1);
    expect(meta.keywords.length).toBeLessThanOrEqual(7);
    for (const k of meta.keywords) {
      expect(typeof k).toBe('string');
      expect(k.length).toBeGreaterThan(0);
      expect(k.length).toBeLessThanOrEqual(50);
    }

    // categories: ちょうど 2 個
    expect(meta.categories).toHaveLength(2);
    for (const c of meta.categories) {
      expect(typeof c).toBe('string');
      expect(c.length).toBeGreaterThan(0);
    }

    // suggested_price_jpy: 99 円以上 (KDP 最低価格 + zod 強制)
    expect(meta.suggested_price_jpy).toBeGreaterThanOrEqual(99);
    expect(meta.suggested_price_jpy).toBeLessThanOrEqual(99999);
    expect(Number.isInteger(meta.suggested_price_jpy)).toBe(true);

    // --- token_usage 検証 -------------------------------------------------
    const rows = await prisma.tokenUsage.findMany({
      where: { theme_session_id: themeSessionId },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    createdTokenUsageIds.push(row.id);

    expect(row.provider).toBe('anthropic');
    expect(row.role).toBe('marketer');
    expect(row.theme_session_id).toBe(themeSessionId);
    expect(row.job_id).toBe(jobId);
    expect(row.book_id).toBeNull();

    // model は ModelAssignment 経由で claude-opus-4-7 (marketer assignment) が選択される
    expect(row.model).toBe('claude-opus-4-7');

    // input_tokens — system prompt + user message で数百〜数千 token 想定。
    // 安全側に > 100 (web_search 起動しない設計なので theme より小さくなる)
    expect(row.input_tokens).toBeGreaterThan(100);
    expect(row.output_tokens).toBeGreaterThan(0);
    expect(row.image_count).toBe(0);

    // unit_price_snapshot — model_catalog 未 seed なら {} / seed 済なら snapshot
    expect(row.unit_price_snapshot).toBeDefined();
    const snapshot = row.unit_price_snapshot as Record<string, unknown>;
    if (Object.keys(snapshot).length === 0) {
      // model_catalog 未 seed: cost_jpy は 0
      expect(Number(row.cost_jpy)).toBe(0);
    } else {
      // seed 済: cost_jpy は正
      expect(Number(row.cost_jpy)).toBeGreaterThan(0);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[T-03-02 token_usage] input=${row.input_tokens} output=${row.output_tokens} ` +
        `cached=${row.cached_input_tokens} cost_jpy=${row.cost_jpy.toString()}`,
    );
  });
});
