/**
 * Runtime verification spec for T-02-06 — image-gen.ts + withImageLogging
 *
 * SP-02 段階では Thumbnail Designer pipeline (S-???) はまだ未配線で、
 * 通常の Playwright (ブラウザ操作 → DOM 検証) では F-032 (画像 API も
 * token_usage に記録) を検証できない。代わりに以下を Node ランタイム上で
 * 直接呼び出して検証する:
 *
 *   1. 一時 Job 行を Prisma で作成 (token_usage.job_id FK 違反回避)
 *   2. withImageLogging(generateImage, { jobId }) で OpenAI gpt-image-1 を実呼出
 *   3. 戻り値 (Buffer + imageCount) を検証
 *   4. token_usage に role='thumbnail_image' / provider='openai' /
 *      model='gpt-image-1' / image_count=1 / input_tokens=0 / output_tokens=0
 *      で 1 行 INSERT されたことを Prisma 直接 SELECT で検証
 *   5. unit_price_snapshot は model_catalog 未 seed のため {} (期待値)
 *   6. クリーンアップ: 一時 token_usage 行 + Job 行 deleteMany
 *
 * 注: 本 spec は `page` を使わない (UI が無いため)。Playwright を test runner
 *     として借用し、@a2p/db / @a2p/agents を直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と
 *     .env.local (OPENAI_API_KEY 実値あり) が前提。
 *
 * コスト: gpt-image-1 standard quality 1024x1024 = $0.04 / 枚 (~6 円)
 *         CI ではスキップ可 (PLAYWRIGHT_SKIP_REAL_API=1)
 */
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';

import { prisma } from '@a2p/db';
import {
  generateImage,
  type OpenAIImagesClient,
} from '@a2p/agents/tools/image-gen';
import { withImageLogging } from '@a2p/agents/lib/with-image-logging';
import { getApiKey, invalidateApiKeyCache } from '@a2p/agents/lib/get-api-key';

// openai は packages/agents の依存 (tests/e2e からは直接 resolve 不可)。
// createRequire で packages/agents の package.json を起点に require する。
const requireFromAgents = createRequire(
  path.resolve(__dirname, '../../packages/agents/package.json'),
);
const openaiMod = requireFromAgents('openai') as
  | { default?: new (opts: { apiKey: string }) => unknown }
  | (new (opts: { apiKey: string }) => unknown);
const OpenAICtor =
  (openaiMod as { default?: new (opts: { apiKey: string }) => unknown }).default ??
  (openaiMod as new (opts: { apiKey: string }) => unknown);

const SKIP_REAL_API = process.env.PLAYWRIGHT_SKIP_REAL_API === '1';

test.describe('runtime: image-gen + withImageLogging (T-02-06)', () => {
  // OpenAI API 実呼出 + 画像 base64 デコード + DB I/O で 30s では足りない可能性
  test.setTimeout(120_000);

  let jobId: string;
  let createdTokenUsageIds: string[] = [];

  test.beforeAll(async () => {
    if (SKIP_REAL_API) return;
    invalidateApiKeyCache();
    // 一時 Job 行を作成 (token_usage.job_id FK 用)
    const job = await prisma.job.create({
      data: {
        kind: 't-02-06-runtime-test',
        payload_json: { source: 'e2e/image-gen-runtime.spec.ts' },
      },
    });
    jobId = job.id;
  });

  test.afterAll(async () => {
    if (SKIP_REAL_API) return;
    // クリーンアップ: 本テストが生成した token_usage と Job のみ削除
    if (createdTokenUsageIds.length > 0) {
      await prisma.tokenUsage.deleteMany({
        where: { id: { in: createdTokenUsageIds } },
      });
    }
    // 念のため job_id でも掃除 (id が掴めなかったケース対策)
    await prisma.tokenUsage.deleteMany({ where: { job_id: jobId } });
    if (jobId) {
      await prisma.job.delete({ where: { id: jobId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  test('generateImage 実呼出 → token_usage 1 行 INSERT (image_count=1, role=thumbnail_image)', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // 事前: 当該 jobId に紐づく token_usage が無いことを確認
    const beforeCount = await prisma.tokenUsage.count({ where: { job_id: jobId } });
    expect(beforeCount).toBe(0);

    // DI: 動的 import を避け、依存を明示注入する
    //   - openaiFactory: static `openai` import で生成した本物クライアントを返す
    //     (動的 import('openai') を踏むと Playwright の ESM loader で
    //      "exports is not defined" を発生させる)
    //   - getApiKey: 同じ理由で static import の getApiKey を直接渡す
    const ctx = { jobId, bookId: undefined, themeSessionId: undefined };
    const wrapped = withImageLogging(generateImage, ctx);

    // 注: 本 spec では quality を意図的に省略する。
    // gpt-image-1 が受理する quality 値は ('low'|'medium'|'high'|'auto') であり、
    // image-gen.ts の `ImageQuality = 'standard' | 'hd'` 型はモデル選定の歴史的
    // 経緯による不一致 (dall-e-3 互換)。Follow-up として programmer に修正提案を
    // 出すが、本 runtime spec は quality 省略で「OpenAI 既定 (auto)」を使う。
    const result = await wrapped(
      {
        prompt:
          'A simple soft gradient background, pastel colors, abstract minimal design',
        width: 1024,
        height: 1024,
        count: 1,
      },
      {
        getApiKey: () => getApiKey('openai'),
        openaiFactory: (apiKey) =>
          new OpenAICtor({ apiKey }) as unknown as OpenAIImagesClient,
      },
    );

    // 1. 戻り値検証
    expect(result.images.length).toBe(1);
    expect(Buffer.isBuffer(result.images[0])).toBe(true);
    expect(result.images[0]!.length).toBeGreaterThan(1024); // 1KB 以上
    expect(result.usage.imageCount).toBe(1);

    // 2. token_usage 行が 1 件 INSERT されたか
    const rows = await prisma.tokenUsage.findMany({ where: { job_id: jobId } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    createdTokenUsageIds.push(row.id);

    expect(row.provider).toBe('openai');
    expect(row.model).toBe('gpt-image-1');
    expect(row.role).toBe('thumbnail_image');
    expect(row.image_count).toBe(1);
    expect(row.input_tokens).toBe(0);
    expect(row.output_tokens).toBe(0);
    expect(row.cached_input_tokens).toBe(0);
    expect(row.book_id).toBeNull();
    expect(row.theme_session_id).toBeNull();
    expect(row.job_id).toBe(jobId);

    // 3. unit_price_snapshot — model_catalog 未 seed なら {} (期待) /
    //    seed 済なら image_price_per_image_usd と fx_rate_usd_jpy が入る
    expect(row.unit_price_snapshot).toBeDefined();
    const snapshot = row.unit_price_snapshot as Record<string, unknown>;
    // snapshot が {} の場合: cost_jpy も 0
    if (Object.keys(snapshot).length === 0) {
      expect(Number(row.cost_jpy)).toBe(0);
    } else {
      // seed 済 → cost_jpy は正の値
      expect(Number(row.cost_jpy)).toBeGreaterThan(0);
    }

    // 4. 生成画像のマジックバイト確認 (PNG: 89 50 4E 47)
    const head = result.images[0]!.subarray(0, 4);
    expect(head[0]).toBe(0x89);
    expect(head[1]).toBe(0x50);
    expect(head[2]).toBe(0x4e);
    expect(head[3]).toBe(0x47);
  });
});
