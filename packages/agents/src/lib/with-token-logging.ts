/**
 * docs/05 §6.2 / F-032 — `LLMClient.complete` を Proxy で wrap し、
 *
 *   1. `token_usage` に 1 行 INSERT
 *   2. (bookId 指定時のみ) `Book.cost_jpy_total` を atomic increment
 *
 * を必ず実行するミドルウェア。生クライアントの new はファクトリ経由に統一され、
 * このミドルウェアを通さない呼出は CI チェック (docs/05 §10.1) で防ぐ。
 *
 * エラー方針:
 *  - LLM 呼出 (`orig.complete`) 失敗は usage 不明のため `token_usage` を残さず
 *    そのまま rethrow (二重カウント・null 行を生まない)。
 *  - INSERT / update 失敗はログに残して握りつぶす。本タスクの観点では LLM
 *    レスポンス自体は既に呼出元に返せる状態にあり、後から監査 (`docs/05 §10`) で
 *    整合性を担保する。
 */
import { prisma as defaultPrisma } from '@a2p/db';

import type {
  AgentRole,
  LLMClient,
  LLMCompleteArgs,
  LLMCompleteResult,
} from '@a2p/contracts/agents';

import { updateBookCost, type UpdateBookCostPrisma } from './update-book-cost.js';

export interface LoggingContext {
  /** 書籍 ID。テーマ生成段階 (Marketer) では未確定なので任意。 */
  bookId?: string;
  /** book_id 未確定時の集計キー (Marketer 初回起動時等)。 */
  themeSessionId?: string;
  /** graphile-worker の Job.id。 */
  jobId?: string;
  /** docs/06: 組織タスク ID — CEO/本部長/担当エージェントの呼出コストを紐付ける。 */
  orgTaskId?: string;
  /** 役割 (Marketer / Writer / ...) — `prompts.role` と同値域。 */
  role: AgentRole;
}

interface TokenUsageCreateData {
  book_id?: string | null;
  theme_session_id?: string | null;
  job_id?: string | null;
  org_task_id?: string | null;
  provider: string;
  model: string;
  role: AgentRole;
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

interface ModelCatalogRepo {
  findFirst(args: {
    where: { provider: string; model: string; is_current: true };
    select?: {
      input_price_per_mtok_usd?: true;
      output_price_per_mtok_usd?: true;
      image_price_per_image_usd?: true;
      fx_rate_usd_jpy?: true;
    };
  }): Promise<Record<string, unknown> | null>;
}

export interface WithTokenLoggingDeps {
  prisma?: {
    tokenUsage: TokenUsageRepo;
  } & UpdateBookCostPrisma & {
    modelCatalog?: ModelCatalogRepo;
  };
  /** 失敗時ログ出力先 (テストで suppress 可)。 */
  logger?: {
    warn(payload: Record<string, unknown>, msg?: string): void;
  };
  /** モデル単価スナップショット取得関数 (テストで差し替え可)。 */
  fetchPriceSnapshot?: (
    provider: string,
    model: string,
  ) => Promise<Record<string, unknown>>;
}

/**
 * 単価スナップショット + トークン使用量から実コスト (JPY) を計算する。
 *
 * LLM クライアント本体は costJpy=0 を返す規約 (ai-sdk-client / agent-sdk-client)。
 * 実コストは本ミドルウェアが、`fetchPriceSnapshot` で得た単価スナップショットを
 * 使ってここで計算する (これが未実装だったため token_usage.cost_jpy が常に 0 で、
 * コストダッシュボードが ¥0 表示になっていた — Hard Rule #5 違反)。
 *
 * 計算式 (USD → JPY):
 *   input  : input_tokens        / 1e6 × input_price_per_mtok_usd
 *   cached : cached_input_tokens / 1e6 × input_price_per_mtok_usd × 0.1 (キャッシュ読取は約 1/10)
 *   output : output_tokens       / 1e6 × output_price_per_mtok_usd
 *   image  : image_count               × image_price_per_image_usd
 *   合計 USD × fx_rate_usd_jpy
 *
 * スナップショットに必要な単価/為替が欠ける場合は 0 を返す (記録は通すが
 * unit_price_snapshot 欠損として後段で検知可能)。
 */
export function computeCostJpy(
  snapshot: Record<string, unknown> | null | undefined,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    imageCount?: number;
  },
): number {
  if (!snapshot) return 0;
  const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const fx = num(snapshot.fx_rate_usd_jpy);
  if (fx <= 0) return 0;
  const inPrice = num(snapshot.input_price_per_mtok_usd);
  const outPrice = num(snapshot.output_price_per_mtok_usd);
  const imgPrice = num(snapshot.image_price_per_image_usd);

  const inputTok = num(usage.inputTokens);
  const cachedTok = num(usage.cachedInputTokens);
  const outputTok = num(usage.outputTokens);
  const images = num(usage.imageCount);

  const usd =
    (inputTok / 1_000_000) * inPrice +
    (cachedTok / 1_000_000) * inPrice * 0.1 +
    (outputTok / 1_000_000) * outPrice +
    images * imgPrice;

  return usd * fx;
}

const defaultLogger = {
  warn(payload: Record<string, unknown>, msg?: string): void {
    // console は構造化ログにならないが、Pino 導入前のフォールバック (docs/05 §10.2 で
    // 後続スプリントが pino 化する想定)。
    // eslint-disable-next-line no-console
    console.warn('[withTokenLogging]', msg ?? '', payload);
  },
};

/**
 * `model_catalog` から `is_current=true` の単価行を取得し、token_usage.unit_price_snapshot
 * に詰める JSON を返す。
 *
 * 未取得時は空オブジェクト (`{}`) を返す。INSERT は通すが、後段の月次集計で
 * `unit_price_snapshot == {}` の行を欠損として検知できる (docs/05 §10.1)。
 */
async function defaultFetchPriceSnapshot(
  provider: string,
  model: string,
  catalog?: ModelCatalogRepo,
): Promise<Record<string, unknown>> {
  if (!catalog) return {};
  try {
    const row = await catalog.findFirst({
      where: { provider, model, is_current: true },
      select: {
        input_price_per_mtok_usd: true,
        output_price_per_mtok_usd: true,
        image_price_per_image_usd: true,
        fx_rate_usd_jpy: true,
      },
    });
    if (!row) return {};
    return row;
  } catch {
    return {};
  }
}

/**
 * docs/05 §6.2 — `LLMClient` を Proxy で wrap し、`complete` 呼出後に
 * `token_usage` INSERT と `Book.cost_jpy_total` atomic increment を行う。
 *
 * @param client wrap 対象の生 LLMClient (`AISdkClient` / `AgentSdkClient`)
 * @param ctx   bookId / themeSessionId / jobId / role を含むロギング文脈
 * @param deps  テスト/差し替え用の依存性注入口
 */
export function withTokenLogging<T extends LLMClient>(
  client: T,
  ctx: LoggingContext,
  deps: WithTokenLoggingDeps = {},
): T {
  const prismaClient = deps.prisma ?? (defaultPrisma as unknown as NonNullable<WithTokenLoggingDeps['prisma']>);
  const logger = deps.logger ?? defaultLogger;
  const catalogRepo = prismaClient.modelCatalog;
  const fetchSnapshot =
    deps.fetchPriceSnapshot ??
    ((provider: string, model: string) => defaultFetchPriceSnapshot(provider, model, catalogRepo));

  return new Proxy(client, {
    get(target, prop, _receiver) {
      // 私有フィールド (`#model` 等) が target インスタンスに付いているため、
      // receiver = Proxy で Reflect.get するとアクセスエラーになる。
      // 非 `complete` のプロパティは target に直接束縛して取得する。
      if (prop !== 'complete') {
        const v = Reflect.get(target as object, prop);
        return typeof v === 'function' ? (v as Function).bind(target) : v;
      }
      const orig = Reflect.get(target as object, prop) as LLMClient['complete'];

      return async function wrappedComplete<R = string>(
        args: LLMCompleteArgs,
      ): Promise<LLMCompleteResult<R>> {
        // 1. LLM 呼出: 失敗はそのまま rethrow (token_usage は記録しない)
        const result = (await orig.call(target, args)) as LLMCompleteResult<R>;

        // 2. token_usage INSERT — 失敗時は warn でログだけ。
        //    コストはクライアントが 0 を返す規約なので、単価スナップショットから
        //    ここで計算する (computeCostJpy)。スナップショット欠損時は client 値に fallback。
        let costJpy = result.costJpy;
        try {
          const snapshot = await fetchSnapshot(result.provider, result.model);
          const computed = computeCostJpy(snapshot, result.usage);
          if (computed > 0) costJpy = computed;
          await prismaClient.tokenUsage.create({
            data: {
              book_id: ctx.bookId ?? null,
              theme_session_id: ctx.themeSessionId ?? null,
              job_id: ctx.jobId ?? null,
              org_task_id: ctx.orgTaskId ?? null,
              provider: result.provider,
              model: result.model,
              role: ctx.role,
              input_tokens: result.usage.inputTokens,
              output_tokens: result.usage.outputTokens,
              cached_input_tokens: result.usage.cachedInputTokens ?? 0,
              image_count: result.usage.imageCount ?? 0,
              unit_price_snapshot: snapshot,
              cost_jpy: costJpy,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              role: ctx.role,
              provider: result.provider,
              model: result.model,
              bookId: ctx.bookId,
              jobId: ctx.jobId,
            },
            'token_usage insert failed',
          );
        }

        // 3. Book.cost_jpy_total atomic increment — bookId 無し (system タスク) はスキップ
        if (ctx.bookId) {
          try {
            await updateBookCost(ctx.bookId, costJpy, prismaClient);
          } catch (err) {
            logger.warn(
              {
                err,
                bookId: ctx.bookId,
                costJpy,
              },
              'updateBookCost failed',
            );
          }
        }

        return result;
      };
    },
  }) as T;
}
