/**
 * docs/05 §6.2 / §10.1 / F-032 — `generateImage` を wrap して `token_usage` に
 * `role='thumbnail_image'` で 1 行 INSERT + (bookId 指定時のみ) `Book.cost_jpy_total`
 * を atomic increment するミドルウェア。
 *
 * `withTokenLogging` と完全対称の構造を取る:
 *  - 呼出 (generateImage) 失敗は usage 不明のため `token_usage` を残さず rethrow。
 *  - INSERT / updateBookCost の失敗は warn ログで握りつぶし、呼出結果は返す。
 *  - `ModelCatalog.image_price_per_image_usd` × `fx_rate_usd_jpy` × imageCount で costJpy 算出。
 *  - snapshot 未取得時は `unit_price_snapshot = {}`, `cost_jpy = 0` で INSERT (warn ログ)
 *    — 月次集計で `unit_price_snapshot == {}` を欠損として検知できる。
 */
import { prisma as defaultPrisma } from '@a2p/db';

import { updateBookCost, type UpdateBookCostPrisma } from './update-book-cost.js';
import { IMAGE_MODEL } from '../tools/image-gen.js';
import type {
  GenerateImageArgs,
  GenerateImageFn,
  GenerateImageResult,
} from '../tools/image-gen.js';

const PROVIDER = 'openai';
// image-gen.ts と同一のモデル名を使い、cost 記録の model_catalog 引きを一致させる。
const MODEL = IMAGE_MODEL;
const ROLE = 'thumbnail_image';

export interface ImageLoggingContext {
  /** 書籍 ID。サムネイル設計の前段では未確定なので任意。 */
  bookId?: string;
  /** book_id 未確定時の集計キー。 */
  themeSessionId?: string;
  /** graphile-worker の Job.id。 */
  jobId?: string;
  /** token_usage.role の上書き (既定 'thumbnail_image')。SNS アイコン/カバー生成等で使用。 */
  role?: string;
}

interface TokenUsageCreateData {
  book_id: string | null;
  theme_session_id: string | null;
  job_id: string | null;
  provider: string;
  model: string;
  role: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  image_count: number;
  unit_price_snapshot: unknown;
  cost_jpy: number;
}

interface TokenUsageRepo {
  create(args: { data: TokenUsageCreateData }): Promise<unknown>;
}

interface ModelCatalogRow {
  image_price_per_image_usd?: unknown;
  fx_rate_usd_jpy?: unknown;
}

interface ModelCatalogRepo {
  findFirst(args: {
    where: { provider: string; model: string; is_current: true };
    select?: {
      input_price_per_mtok_usd?: true;
      output_price_per_mtok_usd?: true;
      image_price_per_image_usd?: true;
      fx_rate_usd_jpy?: true;
    };
  }): Promise<ModelCatalogRow | null>;
}

export interface WithImageLoggingDeps {
  prisma?: {
    tokenUsage: TokenUsageRepo;
  } & UpdateBookCostPrisma & {
    modelCatalog?: ModelCatalogRepo;
  };
  logger?: {
    warn(payload: Record<string, unknown>, msg?: string): void;
  };
  /**
   * モデル単価スナップショット取得関数。
   * 戻り値の snapshot は `token_usage.unit_price_snapshot` にそのまま入る。
   * `costJpy` 未算出時は null を返す (→ INSERT は通すが cost_jpy=0)。
   */
  fetchPriceSnapshot?: (
    provider: string,
    model: string,
    imageCount: number,
  ) => Promise<{ snapshot: Record<string, unknown>; costJpy: number | null }>;
}

const defaultLogger = {
  warn(payload: Record<string, unknown>, msg?: string): void {
    // eslint-disable-next-line no-console
    console.warn('[withImageLogging]', msg ?? '', payload);
  },
};

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (v != null && typeof (v as { toNumber?: () => number }).toNumber === 'function') {
    try {
      const n = (v as { toNumber: () => number }).toNumber();
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
  return null;
}

async function defaultFetchPriceSnapshot(
  provider: string,
  model: string,
  imageCount: number,
  catalog?: ModelCatalogRepo,
): Promise<{ snapshot: Record<string, unknown>; costJpy: number | null }> {
  if (!catalog) return { snapshot: {}, costJpy: null };
  try {
    const row = await catalog.findFirst({
      where: { provider, model, is_current: true },
      select: {
        image_price_per_image_usd: true,
        fx_rate_usd_jpy: true,
      },
    });
    if (!row) return { snapshot: {}, costJpy: null };
    const pricePerImageUsd = toFiniteNumber(row.image_price_per_image_usd);
    const fxRate = toFiniteNumber(row.fx_rate_usd_jpy);
    const snapshot: Record<string, unknown> = {};
    if (pricePerImageUsd !== null) snapshot.image_price_per_image_usd = pricePerImageUsd;
    if (fxRate !== null) snapshot.fx_rate_usd_jpy = fxRate;
    if (pricePerImageUsd === null || fxRate === null) {
      return { snapshot, costJpy: null };
    }
    return {
      snapshot,
      costJpy: pricePerImageUsd * fxRate * imageCount,
    };
  } catch {
    return { snapshot: {}, costJpy: null };
  }
}

/**
 * `generateImage` 関数を wrap し、呼出後に `token_usage` 1 行 INSERT と
 * (bookId 指定時のみ) `Book.cost_jpy_total` の atomic increment を実行する。
 *
 * @param fn   wrap 対象の `generateImage` (本物 or テスト差し替え)
 * @param ctx  bookId / themeSessionId / jobId を含むロギング文脈
 * @param deps テスト/差し替え用の依存性注入口
 */
export function withImageLogging(
  fn: GenerateImageFn,
  ctx: ImageLoggingContext,
  deps: WithImageLoggingDeps = {},
): GenerateImageFn {
  const prismaClient =
    deps.prisma ?? (defaultPrisma as unknown as NonNullable<WithImageLoggingDeps['prisma']>);
  const logger = deps.logger ?? defaultLogger;
  const catalogRepo = prismaClient.modelCatalog;
  const fetchSnapshot =
    deps.fetchPriceSnapshot ??
    ((provider: string, model: string, imageCount: number) =>
      defaultFetchPriceSnapshot(provider, model, imageCount, catalogRepo));
  const role = ctx.role ?? ROLE;

  return async function wrappedGenerateImage(
    args: GenerateImageArgs,
    innerDeps?: Parameters<GenerateImageFn>[1],
  ): Promise<GenerateImageResult> {
    // 1. 画像生成 — 失敗時は token_usage 残さず rethrow
    const result = await fn(args, innerDeps);

    // 2. token_usage INSERT — 失敗時は warn ログ
    let computedCostJpy = result.costJpy;
    try {
      const { snapshot, costJpy } = await fetchSnapshot(
        PROVIDER,
        MODEL,
        result.usage.imageCount,
      );
      if (costJpy !== null) computedCostJpy = costJpy;

      await prismaClient.tokenUsage.create({
        data: {
          book_id: ctx.bookId ?? null,
          theme_session_id: ctx.themeSessionId ?? null,
          job_id: ctx.jobId ?? null,
          provider: PROVIDER,
          model: MODEL,
          role,
          input_tokens: 0,
          output_tokens: 0,
          cached_input_tokens: 0,
          image_count: result.usage.imageCount,
          unit_price_snapshot: snapshot,
          cost_jpy: computedCostJpy,
        },
      });
    } catch (err) {
      logger.warn(
        {
          err,
          role: ROLE,
          provider: PROVIDER,
          model: MODEL,
          bookId: ctx.bookId,
          jobId: ctx.jobId,
          imageCount: result.usage.imageCount,
        },
        'image token_usage insert failed',
      );
    }

    // 3. Book.cost_jpy_total atomic increment — bookId 無し時はスキップ
    if (ctx.bookId) {
      try {
        await updateBookCost(ctx.bookId, computedCostJpy, prismaClient);
      } catch (err) {
        logger.warn(
          {
            err,
            bookId: ctx.bookId,
            costJpy: computedCostJpy,
          },
          'image updateBookCost failed',
        );
      }
    }

    // 呼出元に返す result は costJpy を実値で上書きしておく (UI 表示の利便性)
    return { ...result, costJpy: computedCostJpy };
  };
}
