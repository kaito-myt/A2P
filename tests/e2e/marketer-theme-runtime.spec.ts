/**
 * Runtime verification spec for T-03-01 — Marketer エージェント (テーマ生成)
 *
 * SP-03 段階では Marketer を起点とする UI / worker パイプラインはまだ配線されて
 * いないため、通常の Playwright (ブラウザ操作 → DOM 検証) では F-001 を検証
 * できない。代わりに以下を Node ランタイム上で直接呼び出して検証する:
 *
 *   1. 一時 Account → Job 行を Prisma で作成 (token_usage.job_id FK 違反回避)
 *      theme_session_id は FK 制約を持たない自由テキストなので任意の値で OK
 *   2. generateMarketerThemes({ ..., count: 3 }) を Anthropic claude-opus-4-7 +
 *      web_search server tool 経由で実呼出
 *   3. 戻り値 (candidates[]) を検証:
 *      - 長さ 3 / title・hook・target_reader・signals の必須項目
 *      - signals.reasoning / market_score / predicted_chapters が zod 通過 (= 受領済)
 *      - competitors に少なくとも 1 件 (web_search の reference があるはず) ※warn 想定
 *   4. token_usage に role='marketer' / provider='anthropic' で 1 行 INSERT を確認
 *      theme_session_id 紐付け + input_tokens > 0 + output_tokens > 0
 *   5. クリーンアップ: 一時 TokenUsage + Job + Account を deleteMany
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner
 *     として借用し、@a2p/db / @a2p/agents/marketer を直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と
 *     .env.local (ANTHROPIC_API_KEY 実値あり) が前提。
 *     ModelAssignment (marketer, anthropic, claude-opus-4-7) + Prompt
 *     (role='marketer', genre=null active) が seed 済であることも前提。
 *
 * コスト: claude-opus-4-7 + web_search 1 呼出 ≒ $0.10-0.20 / run (~15-30 円)
 *         CI ではスキップ可 (PLAYWRIGHT_SKIP_REAL_API=1)
 *
 * 設計判断 (本 spec 固有):
 *  - prompts table の Marketer プロンプトは seed 段階では "${input_summary}" 等を
 *    含む placeholder 形式 (T-03-01 task spec 注記参照)。実装側 (theme.ts) は
 *    `fillPlaceholders` で {brief}/{genre}/{count}/{exclude_titles} のみ差し込む
 *    ので、未知のプレースホルダはそのまま残る。Marketer の出力品質はこの段階
 *    では「web_search が機能し、構造化 JSON が返ってくれば OK」レベルで判定する。
 *  - `web_search_20250305` は Anthropic 側で server tool 完結なので、retry や
 *    レイテンシは Anthropic 側のチューニングに委ねる (本 spec は 5 分上限)。
 */
import { test, expect } from '@playwright/test';

import { prisma } from '@a2p/db';
import { generateMarketerThemes } from '@a2p/agents/marketer/theme';
import { invalidateApiKeyCache } from '@a2p/agents/lib/get-api-key';

const SKIP_REAL_API = process.env.PLAYWRIGHT_SKIP_REAL_API === '1';
const TEST_TAG = 't-03-01-runtime-test';

test.describe('runtime: Marketer generateMarketerThemes (T-03-01)', () => {
  // Anthropic + web_search + 構造化 JSON 生成 + DB I/O は 30s では不足の可能性。
  // claude-opus-4-7 の応答 + 複数回 web 検索で 60-180s 程度を想定。
  // MAX_ATTEMPTS=5 retry を考慮して 600s に余裕を持たせる
  // (1 attempt ~120s × 5 = 600s; 通常は 1 attempt で完了)。
  test.setTimeout(600_000);

  let accountId: string;
  let jobId: string;
  let themeSessionId: string;
  let createdTokenUsageIds: string[] = [];

  test.beforeAll(async () => {
    if (SKIP_REAL_API) return;
    invalidateApiKeyCache();

    // 1) 一時 Account を作成
    const account = await prisma.account.create({
      data: {
        pen_name: `e2e-marketer-${Date.now()}`,
        genre_policy_json: {
          primary_genre: 'business',
          ratio: { business: 1 },
          focus_themes: ['remote_work'],
        },
        status: 'archived', // ダッシュボード一覧に出さない
      },
    });
    accountId = account.id;

    // 2) 一時 Job を作成 (token_usage.job_id FK 用)
    const job = await prisma.job.create({
      data: {
        kind: 't-03-01-runtime-test',
        payload_json: { source: 'e2e/marketer-theme-runtime.spec.ts' },
      },
    });
    jobId = job.id;

    // 3) theme_session_id は FK 制約を持たない自由テキストなので、
    //    一意性が分かるラベル付き文字列で OK (TEST_TAG + timestamp)
    themeSessionId = `${TEST_TAG}-session-${Date.now()}`;
  });

  test.afterAll(async () => {
    if (SKIP_REAL_API) return;

    // クリーンアップ: 本テストで生成した token_usage 行を確実に消す
    // 1) themeSessionId 紐付け
    if (themeSessionId) {
      await prisma.tokenUsage
        .deleteMany({ where: { theme_session_id: themeSessionId } })
        .catch(() => undefined);
    }
    // 2) jobId 紐付け (重複削除は no-op)
    if (jobId) {
      await prisma.tokenUsage
        .deleteMany({ where: { job_id: jobId } })
        .catch(() => undefined);
    }
    // 3) id 直接指定 (取りこぼし防止)
    if (createdTokenUsageIds.length > 0) {
      await prisma.tokenUsage
        .deleteMany({ where: { id: { in: createdTokenUsageIds } } })
        .catch(() => undefined);
    }

    // Job / Account 削除
    if (jobId) {
      await prisma.job.delete({ where: { id: jobId } }).catch(() => undefined);
    }
    if (accountId) {
      // Account 削除で関連 books / theme_candidates 等は cascade されるが、
      // 本テストでは theme_candidates を直接作っていない (Marketer は DB 書込
      // をしないので) ので Account 単独削除で十分。
      await prisma.account
        .delete({ where: { id: accountId } })
        .catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  test('generateMarketerThemes 実呼出 → candidates 3 件 + token_usage 1 行 (role=marketer)', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // 事前: 当該 themeSessionId / jobId に紐づく token_usage が無いことを確認
    const beforeCount = await prisma.tokenUsage.count({
      where: {
        OR: [{ theme_session_id: themeSessionId }, { job_id: jobId }],
      },
    });
    expect(beforeCount).toBe(0);

    // --- 実呼出 (retry 付き) ----------------------------------------------
    // T-03-01 既知 stochastic flake への防御: Marketer の LLM 出力は稀に
    // 構造化 JSON を返さず `AgentError('marketer.theme.invalid_output: ...')` で
    // 失敗する。T-03-06 iteration で extractJson を強化 (markdown fence 全マッチ
    // + balanced 全候補スキャン) したため通常は 1 回目で成功するが、稀に LLM が
    // 「説明文だけで JSON を返さない」ケースが残るため最大 5 回まで retry し、
    // 各 retry の前に前回失敗で残った token_usage を掃除する。
    // また test.setTimeout(300s) のため 5 回 retry でも余裕を持って収まるよう、
    // failure 時のオーバーヘッドは「token_usage deleteMany 1 回」のみに抑える。
    const MAX_ATTEMPTS = 5;
    let result: Awaited<ReturnType<typeof generateMarketerThemes>> | null = null;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        result = await generateMarketerThemes({
          themeSessionId,
          jobId,
          accountId,
          genre: 'business',
          keywordOrBrief: 'リモートワーク時代のチームマネジメント',
          excludeTitlesRecent: [],
          count: 3, // コスト抑制
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        // marketer.theme.invalid_output のみ retry。それ以外 (ProviderError /
        // ConfigError 等) は即 throw。
        const isInvalidOutput = msg.startsWith('marketer.theme.invalid_output');
        // eslint-disable-next-line no-console
        console.warn(
          `[T-03-01 runtime] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`,
        );
        // 失敗 rawText を debug 出力 — 連続失敗時の LLM 出力傾向 (candidates 欠落等)
        // を直接確認できるようにする (iteration 4 で追加)。
        const details = (err as { details?: { rawText?: string } }).details;
        if (details?.rawText) {
          // eslint-disable-next-line no-console
          console.warn(
            `[T-03-01 attempt ${attempt}] rawText (first 2000 chars):\n${details.rawText.slice(0, 2000)}`,
          );
        }
        if (!isInvalidOutput) throw err;
        if (attempt === MAX_ATTEMPTS) break;
        // 前回失敗で書かれた token_usage を掃除して再投入準備
        await prisma.tokenUsage.deleteMany({
          where: {
            OR: [{ theme_session_id: themeSessionId }, { job_id: jobId }],
          },
        });
      }
    }
    if (lastErr || !result) {
      throw lastErr ?? new Error('generateMarketerThemes returned no result');
    }

    // --- 戻り値検証 -------------------------------------------------------
    expect(result.candidates.length).toBe(3);

    // デバッグ用: 生成 candidates をログ (Playwright list reporter に出る)
    // 競合書籍 / signals の中身もここで露出させる。
    for (const [i, c] of result.candidates.entries()) {
      // eslint-disable-next-line no-console
      console.log(
        `[T-03-01 candidate ${i + 1}] title="${c.title}" ` +
          `target="${c.target_reader.slice(0, 40)}..." ` +
          `competitors=${c.competitors.length} ` +
          `market_score=${c.signals.market_score} ` +
          `predicted_chapters=${c.signals.predicted_chapters}`,
      );
    }

    for (const c of result.candidates) {
      // F-001 受入: title/hook/target_reader/competitors/signals
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.title.length).toBeLessThanOrEqual(200);
      expect(c.hook.length).toBeGreaterThan(0);
      expect(c.target_reader.length).toBeGreaterThan(0);

      // signals: zod 検証は generateMarketerThemes 内で済んでいる。
      // 値域だけ再確認 (zod 範囲と一致)。
      expect(c.signals.reasoning.length).toBeGreaterThan(0);
      expect(c.signals.market_score).toBeGreaterThanOrEqual(0);
      expect(c.signals.market_score).toBeLessThanOrEqual(100);
      expect(c.signals.predicted_chapters).toBeGreaterThanOrEqual(3);
      expect(c.signals.predicted_chapters).toBeLessThanOrEqual(20);
      expect(Array.isArray(c.signals.search_keywords)).toBe(true);

      // competitors は web_search 結果に左右される。
      // F-001 受入基準は「望ましい」レベルで min 制約は無いが、Marketer は
      // web_search を必ず叩く設計のため、3 件中少なくとも 1 件以上は
      // competitors を持つことを soft 期待する (= aggregate で >= 1)。
      expect(Array.isArray(c.competitors)).toBe(true);
    }

    // 3 候補横断で competitors の総数を計上し、>= 1 を期待
    // (Marketer は web_search を使う前提。0 なら warn 級だが test は fail させる)
    const totalCompetitors = result.candidates.reduce(
      (acc, c) => acc + c.competitors.length,
      0,
    );
    // eslint-disable-next-line no-console
    console.log(`[T-03-01] total competitors across 3 candidates: ${totalCompetitors}`);
    expect(totalCompetitors).toBeGreaterThanOrEqual(1);

    // title 一意性 (重複除外ロジックが働いていれば全て unique)
    const titles = result.candidates.map((c) => c.title);
    const titleSet = new Set(titles.map((t) => t.normalize('NFKC').trim().toLowerCase()));
    expect(titleSet.size).toBe(titles.length);

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

    // model は ModelAssignment 経由で claude-opus-4-7 が選択されるはず
    expect(row.model).toBe('claude-opus-4-7');

    // input_tokens — system prompt + user message + web_search 結果込みで
    // 数百〜数千 token 想定。安全側に「> 100」で評価 (web_search 失敗時の
    // 異常検知)。
    expect(row.input_tokens).toBeGreaterThan(100);
    expect(row.output_tokens).toBeGreaterThan(0);
    expect(row.image_count).toBe(0);

    // unit_price_snapshot — model_catalog 未 seed なら {} (期待) /
    // seed 済なら input/output 単価 + fx_rate が入る
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
      `[T-03-01 token_usage] input=${row.input_tokens} output=${row.output_tokens} ` +
        `cached=${row.cached_input_tokens} cost_jpy=${row.cost_jpy.toString()}`,
    );
  });
});
