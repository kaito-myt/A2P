import type { JobHelpers, Task } from 'graphile-worker';

import { getApiKey } from '@a2p/agents/lib/get-api-key';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma, Prisma } from '@a2p/db';
import { buildPricingChangedEmail, sendEmail } from '@a2p/notify';

/**
 * `catalog.fetch` タスク (T-02-09, docs/05 §5.3.12 / docs/03 §B-01〜B-05)
 *
 * 3 プロバイダ (Anthropic / OpenAI / Google) について:
 *   1. SDK / REST 経由で `models.list()` を呼び、運用対象モデル ID を確定
 *   2. 公式 pricing ページを fetch + cheerio で解析し、各モデルの単価を抽出
 *   3. `AppSettings.latest_fx_rate` を `fx_rate_usd_jpy` として `ModelCatalog` に保存
 *   4. 既存 `is_current=true` 行を `is_current=false` 化 → 新行を `is_current=true` で INSERT
 *      (`@@unique([provider, model, fetched_at])` で重複防止、`fetched_at = now()`)
 *   5. 前回 (= 直前の is_current) と比較し、|delta| > 10% なら
 *      `catalog_price_change` Alert + `pricing-changed` メール送信
 *
 * **運用継続優先の設計判断 (docs/03 §B-05 / T-02-09 task spec)**:
 *   - 1 provider 失敗 → 他 2 provider は継続実行
 *   - 失敗した provider のみ `catalog_fetch_failed` Alert を INSERT
 *   - 全 provider 失敗でも task 自体は throw せず `{ ok: false }` 返却
 *     (cron 次回実行で再試行する想定 / graphile-worker のリトライに乗せない)
 *
 * **alert.kind の正本は `catalog_price_change`** (docs/05 §3 + seed.ts の
 * `notification_kinds_json` キー)。task spec の `pricing_changed` は表記揺れ。
 *
 * **fx_rate fallback**: `AppSettings.latest_fx_rate` が NULL の場合 (fx.fetch 未実行 or 失敗継続中)、
 * 150.0 を fallback として使用しつつ warn ログを出す。これにより catalog 取得は止まらない。
 */

export const CATALOG_FETCH_TASK_NAME = 'catalog.fetch';

/** docs/05 §3 Alert.kind 列挙の正本 (±10% 変動 = catalog_price_change)。 */
const ALERT_KIND_PRICE_CHANGE = 'catalog_price_change';
const ALERT_KIND_FETCH_FAILED = 'catalog_fetch_failed';

/** 単価変動アラートを発火する閾値 (|delta_pct| > 10%)。 */
const PRICE_CHANGE_THRESHOLD = 0.1;

/** fx_rate 未取得時の fallback。docs/03 §B-04 の歴史平均値ベース。 */
const FX_RATE_FALLBACK = 150.0;

export type Provider = 'anthropic' | 'openai' | 'google';

/** scrape 結果として抽出された単一モデルの単価 (USD 建て)。 */
export interface ProviderPricingEntry {
  /** モデル ID (例: 'claude-opus-4-7', 'gpt-4o', 'gemini-2.5-pro')。 */
  model: string;
  /** 入力単価 USD/Mtok。 */
  input_price_per_mtok_usd: number;
  /** 出力単価 USD/Mtok。 */
  output_price_per_mtok_usd: number;
  /** 画像 1 枚あたり USD (OpenAI gpt-image-1 等)。任意。 */
  image_price_per_image_usd?: number;
}

export interface ProviderFetchResult {
  provider: Provider;
  ok: boolean;
  /** 成功時のみ。pricing ページから抽出した単価のリスト。 */
  pricing?: ProviderPricingEntry[];
  /** SDK `models.list()` で取得した生のモデル ID リスト (デバッグ/raw_json 用)。 */
  modelIdsFromSdk?: string[];
  /** ソース文字列 ('anthropic_pricing_page_v1' 等)。 */
  source: string;
  /** 失敗理由 (failure 時のみ)。 */
  error?: string;
}

/**
 * Prisma 部分インターフェース。catalog.fetch が触る最小サブセットのみ要求。
 * テストで mock しやすくする。
 */
export interface CatalogFetchPrisma {
  appSettings: {
    findUnique: (args: {
      where: { id: string };
    }) => Promise<{ latest_fx_rate: Prisma.Decimal | null } | null>;
  };
  modelCatalog: {
    findMany: (args: {
      where: { provider: string; model?: string; is_current?: boolean };
    }) => Promise<
      Array<{
        provider: string;
        model: string;
        input_price_per_mtok_usd: Prisma.Decimal;
        output_price_per_mtok_usd: Prisma.Decimal;
        image_price_per_image_usd: Prisma.Decimal | null;
        fx_rate_usd_jpy: Prisma.Decimal;
        is_current: boolean;
      }>
    >;
    updateMany: (args: {
      where: { provider: string; model: { in: string[] }; is_current: boolean };
      data: { is_current: boolean };
    }) => Promise<{ count: number }>;
    create: (args: { data: ModelCatalogCreateData }) => Promise<unknown>;
  };
  alert: {
    create: (args: {
      data: {
        kind: string;
        severity: string;
        payload_json: Prisma.InputJsonValue;
      };
    }) => Promise<unknown>;
  };
}

interface ModelCatalogCreateData {
  provider: string;
  model: string;
  input_price_per_mtok_usd: Prisma.Decimal;
  output_price_per_mtok_usd: Prisma.Decimal;
  image_price_per_image_usd: Prisma.Decimal | null;
  fx_rate_usd_jpy: Prisma.Decimal;
  fetched_at: Date;
  source: string;
  raw_json: Prisma.InputJsonValue;
  is_current: boolean;
}

/**
 * provider 別の fetcher。各 fetcher は SDK / cheerio / HTTP を内部で叩き、
 * `ProviderFetchResult` を返す (throw しない契約 — 失敗は ok:false で表現)。
 *
 * テストでは provider fetcher 全体を差し替えてスクレイピングと SDK を回避する。
 */
export type ProviderFetcher = (deps: ProviderFetcherDeps) => Promise<ProviderFetchResult>;

export interface ProviderFetcherDeps {
  /** API キー (DB or env)。`getApiKey(provider)` 経由。 */
  apiKey: string;
  /** HTTP fetch (テストで差し替え)。 */
  fetchImpl: typeof globalThis.fetch;
  /** ロガー。 */
  logger: Logger;
}

export interface CatalogFetchDeps {
  prisma?: CatalogFetchPrisma;
  /** 各 provider の fetcher 差し替え。未指定なら本番実装。 */
  providerFetchers?: Partial<Record<Provider, ProviderFetcher>>;
  /** API キー取得を差し替え (テスト)。 */
  getApiKeyImpl?: (provider: Provider) => Promise<string>;
  /** HTTP fetch 差し替え (テスト)。既定は globalThis.fetch。 */
  fetchImpl?: typeof globalThis.fetch;
  /** メール送信差し替え (テスト)。 */
  sendEmailImpl?: typeof sendEmail;
  /** 「今」を固定 (テスト時の fetched_at 制御)。 */
  now?: () => Date;
  /** ロガー差し替え。 */
  logger?: Logger;
}

export interface CatalogFetchSummary {
  /** 1 つでも provider が成功し、ModelCatalog に新規行が入ったら true。 */
  ok: boolean;
  providers: Record<Provider, ProviderRunSummary>;
}

export interface ProviderRunSummary {
  ok: boolean;
  upsertedCount: number;
  priceChangeAlertCount: number;
  /** 失敗 provider のみ非 null。 */
  errorReason?: string;
}

const PROVIDERS: readonly Provider[] = ['anthropic', 'openai', 'google'] as const;

/**
 * テストから直接呼べる純粋ヘルパ。graphile-worker の Task ラッパとは分離。
 */
export async function runCatalogFetch(
  deps: CatalogFetchDeps = {},
): Promise<CatalogFetchSummary> {
  const log = deps.logger ?? createLogger(`worker.${CATALOG_FETCH_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as CatalogFetchPrisma);
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const sendMailFn = deps.sendEmailImpl ?? sendEmail;
  const getKey = deps.getApiKeyImpl ?? ((p: Provider) => getApiKey(p));
  const now = deps.now ?? (() => new Date());
  const fetchedAt = now();

  log.info({ task: CATALOG_FETCH_TASK_NAME }, 'catalog fetch start');

  // fx_rate を取得 (NULL 時は fallback)
  const fxRate = await resolveFxRate(prisma, log);

  const summary: CatalogFetchSummary = {
    ok: false,
    providers: {
      anthropic: { ok: false, upsertedCount: 0, priceChangeAlertCount: 0 },
      openai: { ok: false, upsertedCount: 0, priceChangeAlertCount: 0 },
      google: { ok: false, upsertedCount: 0, priceChangeAlertCount: 0 },
    },
  };

  for (const provider of PROVIDERS) {
    const providerLog = log.child
      ? log.child({ provider })
      : (log as Logger);

    let apiKey: string;
    try {
      apiKey = await getKey(provider);
    } catch (err) {
      providerLog.warn({ err }, 'failed to resolve api key; skipping provider');
      summary.providers[provider] = {
        ok: false,
        upsertedCount: 0,
        priceChangeAlertCount: 0,
        errorReason: err instanceof Error ? `api_key_missing:${err.message}` : 'api_key_missing',
      };
      await safeAlertFetchFailed(prisma, providerLog, {
        provider,
        error: 'api key not configured',
      });
      continue;
    }

    const fetcher =
      deps.providerFetchers?.[provider] ?? defaultProviderFetcher(provider);

    let fetchResult: ProviderFetchResult;
    try {
      fetchResult = await fetcher({ apiKey, fetchImpl, logger: providerLog });
    } catch (err) {
      // fetcher 契約違反 (throw された) — 防御的にここでも握りつぶす
      providerLog.warn({ err }, 'provider fetcher threw (unexpected); treating as failure');
      fetchResult = {
        provider,
        ok: false,
        source: defaultSourceFor(provider),
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (!fetchResult.ok || !fetchResult.pricing || fetchResult.pricing.length === 0) {
      const reason = fetchResult.error ?? 'no_pricing_extracted';
      providerLog.warn(
        { reason, source: fetchResult.source },
        'provider fetch failed; previous catalog rows kept (is_current unchanged)',
      );
      await safeAlertFetchFailed(prisma, providerLog, { provider, error: reason });
      summary.providers[provider] = {
        ok: false,
        upsertedCount: 0,
        priceChangeAlertCount: 0,
        errorReason: reason,
      };
      continue;
    }

    // 上書き: 既存 is_current=true の同じモデル群を false に、新行を INSERT
    const upsertResult = await upsertProviderCatalog(prisma, providerLog, {
      provider,
      pricing: fetchResult.pricing,
      fxRate,
      source: fetchResult.source,
      fetchedAt,
      rawSdkModels: fetchResult.modelIdsFromSdk ?? [],
    });

    // ±10% 変動アラート
    const alertCount = await detectAndAlertPriceChanges(prisma, providerLog, sendMailFn, {
      provider,
      current: fetchResult.pricing,
      previous: upsertResult.previousByModel,
    });

    summary.providers[provider] = {
      ok: true,
      upsertedCount: upsertResult.upsertedCount,
      priceChangeAlertCount: alertCount,
    };
  }

  summary.ok = Object.values(summary.providers).some((r) => r.ok);

  log.info(
    { task: CATALOG_FETCH_TASK_NAME, summary },
    summary.ok ? 'catalog fetch done' : 'catalog fetch finished with all providers failed',
  );

  return summary;
}

// ---------------------------------------------------------------------------
// 内部ヘルパ
// ---------------------------------------------------------------------------

async function resolveFxRate(
  prisma: CatalogFetchPrisma,
  log: Logger,
): Promise<Prisma.Decimal> {
  try {
    const settings = await prisma.appSettings.findUnique({ where: { id: 'singleton' } });
    if (settings?.latest_fx_rate !== undefined && settings?.latest_fx_rate !== null) {
      return settings.latest_fx_rate;
    }
  } catch (err) {
    log.warn({ err }, 'failed to read AppSettings.latest_fx_rate; using fallback');
  }
  log.warn(
    { fallback: FX_RATE_FALLBACK },
    'AppSettings.latest_fx_rate is null; using fallback (fx.fetch should run first)',
  );
  return new Prisma.Decimal(FX_RATE_FALLBACK);
}

interface UpsertArgs {
  provider: Provider;
  pricing: ProviderPricingEntry[];
  fxRate: Prisma.Decimal;
  source: string;
  fetchedAt: Date;
  rawSdkModels: string[];
}

interface UpsertResult {
  upsertedCount: number;
  /** 直前 (旧 is_current=true) の単価を model 名でひける map。比較用。 */
  previousByModel: Map<string, { input: number; output: number }>;
}

async function upsertProviderCatalog(
  prisma: CatalogFetchPrisma,
  log: Logger,
  args: UpsertArgs,
): Promise<UpsertResult> {
  const modelNames = args.pricing.map((p) => p.model);

  // 旧 is_current 行を取得 (比較用)
  const existing = await prisma.modelCatalog.findMany({
    where: { provider: args.provider, is_current: true },
  });
  const previousByModel = new Map<string, { input: number; output: number }>();
  for (const row of existing) {
    if (modelNames.includes(row.model)) {
      previousByModel.set(row.model, {
        input: row.input_price_per_mtok_usd.toNumber(),
        output: row.output_price_per_mtok_usd.toNumber(),
      });
    }
  }

  // 旧 is_current=true の同一 (provider, model) 群を false に下げる
  await prisma.modelCatalog.updateMany({
    where: { provider: args.provider, model: { in: modelNames }, is_current: true },
    data: { is_current: false },
  });

  // 新行を INSERT
  let upserted = 0;
  for (const entry of args.pricing) {
    const data: ModelCatalogCreateData = {
      provider: args.provider,
      model: entry.model,
      input_price_per_mtok_usd: new Prisma.Decimal(entry.input_price_per_mtok_usd),
      output_price_per_mtok_usd: new Prisma.Decimal(entry.output_price_per_mtok_usd),
      image_price_per_image_usd:
        entry.image_price_per_image_usd !== undefined
          ? new Prisma.Decimal(entry.image_price_per_image_usd)
          : null,
      fx_rate_usd_jpy: args.fxRate,
      fetched_at: args.fetchedAt,
      source: args.source,
      raw_json: {
        scraped_at: args.fetchedAt.toISOString(),
        sdk_models: args.rawSdkModels,
        pricing_entry: {
          model: entry.model,
          input_per_mtok_usd: entry.input_price_per_mtok_usd,
          output_per_mtok_usd: entry.output_price_per_mtok_usd,
          ...(entry.image_price_per_image_usd !== undefined
            ? { image_per_image_usd: entry.image_price_per_image_usd }
            : {}),
        },
      } as Prisma.InputJsonValue,
      is_current: true,
    };
    try {
      await prisma.modelCatalog.create({ data });
      upserted++;
    } catch (err) {
      log.warn(
        { err, provider: args.provider, model: entry.model },
        'ModelCatalog.create failed for entry; continuing',
      );
    }
  }

  return { upsertedCount: upserted, previousByModel };
}

async function detectAndAlertPriceChanges(
  prisma: CatalogFetchPrisma,
  log: Logger,
  sendMailFn: typeof sendEmail,
  args: {
    provider: Provider;
    current: ProviderPricingEntry[];
    previous: Map<string, { input: number; output: number }>;
  },
): Promise<number> {
  let alertCount = 0;
  for (const entry of args.current) {
    const prev = args.previous.get(entry.model);
    if (!prev) continue; // 初回 — alert なし

    const deltas = [
      computeDeltaPct(prev.input, entry.input_price_per_mtok_usd),
      computeDeltaPct(prev.output, entry.output_price_per_mtok_usd),
    ];
    const max = Math.max(...deltas.map((d) => Math.abs(d)));
    if (max <= PRICE_CHANGE_THRESHOLD) continue;

    // |delta| > 10% — alert + メール
    const inputDeltaPct = deltas[0]!;
    const outputDeltaPct = deltas[1]!;
    // メール文の代表値は input 単価とその delta% を使う (PRICING_CHANGED テンプレ仕様)
    const reportedDeltaPct = Math.abs(inputDeltaPct) >= Math.abs(outputDeltaPct)
      ? inputDeltaPct
      : outputDeltaPct;
    const reportedOld = Math.abs(inputDeltaPct) >= Math.abs(outputDeltaPct)
      ? prev.input
      : prev.output;
    const reportedNew = Math.abs(inputDeltaPct) >= Math.abs(outputDeltaPct)
      ? entry.input_price_per_mtok_usd
      : entry.output_price_per_mtok_usd;

    try {
      await prisma.alert.create({
        data: {
          kind: ALERT_KIND_PRICE_CHANGE,
          severity: 'warning',
          payload_json: {
            provider: args.provider,
            model: entry.model,
            before: {
              input_price_per_mtok_usd: prev.input,
              output_price_per_mtok_usd: prev.output,
            },
            after: {
              input_price_per_mtok_usd: entry.input_price_per_mtok_usd,
              output_price_per_mtok_usd: entry.output_price_per_mtok_usd,
            },
            delta_pct: {
              input: round2(inputDeltaPct * 100),
              output: round2(outputDeltaPct * 100),
            },
          },
        },
      });
      alertCount++;
    } catch (err) {
      log.warn({ err, provider: args.provider, model: entry.model }, 'failed to insert price change alert');
    }

    try {
      const built = buildPricingChangedEmail({
        model: `${args.provider}/${entry.model}`,
        oldUsdPerMtok: reportedOld,
        newUsdPerMtok: reportedNew,
        deltaPct: round2(reportedDeltaPct * 100),
      });
      await sendMailFn({ subject: built.subject, react: built.react });
    } catch (err) {
      // メール送信失敗は alert INSERT より後段なので warn のみ (DB 記録は残る)
      log.warn({ err, provider: args.provider, model: entry.model }, 'pricing-changed email send failed');
    }
  }
  return alertCount;
}

function computeDeltaPct(before: number, after: number): number {
  if (!Number.isFinite(before) || before <= 0) return 0;
  return (after - before) / before;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function safeAlertFetchFailed(
  prisma: CatalogFetchPrisma,
  log: Logger,
  args: { provider: Provider; error: string },
): Promise<void> {
  try {
    await prisma.alert.create({
      data: {
        kind: ALERT_KIND_FETCH_FAILED,
        severity: 'warning',
        payload_json: {
          provider: args.provider,
          error: args.error,
          occurred_at: new Date().toISOString(),
        },
      },
    });
  } catch (err) {
    log.warn({ err, provider: args.provider }, 'failed to insert catalog_fetch_failed alert');
  }
}

function defaultSourceFor(provider: Provider): string {
  switch (provider) {
    case 'anthropic':
      return 'anthropic_pricing_page_v1';
    case 'openai':
      return 'openai_pricing_v2';
    case 'google':
      return 'google_pricing_v1';
  }
}

// ---------------------------------------------------------------------------
// 本番 provider fetcher 実装 (SDK + cheerio)
// ---------------------------------------------------------------------------

function defaultProviderFetcher(provider: Provider): ProviderFetcher {
  switch (provider) {
    case 'anthropic':
      return fetchAnthropicCatalog;
    case 'openai':
      return fetchOpenAICatalog;
    case 'google':
      return fetchGoogleCatalog;
  }
}

const ANTHROPIC_PRICING_URL = 'https://docs.anthropic.com/en/docs/about-claude/models/overview';
const OPENAI_PRICING_URL = 'https://openai.com/api/pricing/';
const GOOGLE_PRICING_URL = 'https://ai.google.dev/gemini-api/docs/pricing';

/** Anthropic — `@anthropic-ai/sdk` の `client.models.list()` + cheerio で pricing ページ解析。 */
async function fetchAnthropicCatalog(
  deps: ProviderFetcherDeps,
): Promise<ProviderFetchResult> {
  const source = 'anthropic_pricing_page_v1';
  try {
    const Anthropic = await loadAnthropic();
    const client = new Anthropic({ apiKey: deps.apiKey });
    const models = await collectSdkModelIds(client, 'anthropic');
    deps.logger.info({ count: models.length }, 'anthropic models.list ok');

    const html = await safeFetchText(deps.fetchImpl, ANTHROPIC_PRICING_URL);
    const pricing = await parseAnthropicPricing(html, models);
    if (pricing.length === 0) {
      return { provider: 'anthropic', ok: false, source, error: 'no_pricing_rows_parsed' };
    }
    return { provider: 'anthropic', ok: true, source, pricing, modelIdsFromSdk: models };
  } catch (err) {
    return {
      provider: 'anthropic',
      ok: false,
      source,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** OpenAI — `openai` SDK `client.models.list()` + cheerio で pricing ページ解析。 */
async function fetchOpenAICatalog(
  deps: ProviderFetcherDeps,
): Promise<ProviderFetchResult> {
  const source = 'openai_pricing_v2';
  try {
    const OpenAI = await loadOpenAI();
    const client = new OpenAI({ apiKey: deps.apiKey });
    const models = await collectSdkModelIds(client, 'openai');
    deps.logger.info({ count: models.length }, 'openai models.list ok');

    const html = await safeFetchText(deps.fetchImpl, OPENAI_PRICING_URL);
    const pricing = await parseOpenAIPricing(html, models);
    if (pricing.length === 0) {
      return { provider: 'openai', ok: false, source, error: 'no_pricing_rows_parsed' };
    }
    return { provider: 'openai', ok: true, source, pricing, modelIdsFromSdk: models };
  } catch (err) {
    return {
      provider: 'openai',
      ok: false,
      source,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Google — REST `GET /v1beta/models?key=...` + cheerio で pricing ページ解析。 */
async function fetchGoogleCatalog(
  deps: ProviderFetcherDeps,
): Promise<ProviderFetchResult> {
  const source = 'google_pricing_v1';
  try {
    const models = await listGoogleModels(deps.fetchImpl, deps.apiKey);
    deps.logger.info({ count: models.length }, 'google models.list ok');

    const html = await safeFetchText(deps.fetchImpl, GOOGLE_PRICING_URL);
    const pricing = await parseGooglePricing(html, models);
    if (pricing.length === 0) {
      return { provider: 'google', ok: false, source, error: 'no_pricing_rows_parsed' };
    }
    return { provider: 'google', ok: true, source, pricing, modelIdsFromSdk: models };
  } catch (err) {
    return {
      provider: 'google',
      ok: false,
      source,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function loadAnthropic(): Promise<new (opts: { apiKey: string }) => AnthropicClient> {
  // @ts-ignore — @anthropic-ai/sdk は @a2p/agents 経由で transitive に存在するが、
  //   worker 自身の node_modules には居ないため tsc が見つけられない。
  //   ランタイムは pnpm のシンボリックリンク解決で問題なくロードできる。
  const mod = await import('@anthropic-ai/sdk');
  const Default = (mod as { default?: new (opts: { apiKey: string }) => AnthropicClient }).default;
  return Default ?? (mod as unknown as new (opts: { apiKey: string }) => AnthropicClient);
}

async function loadOpenAI(): Promise<new (opts: { apiKey: string }) => OpenAIClient> {
  // @ts-ignore — openai SDK は @a2p/agents 経由で transitive に存在 (同上)。
  const mod = await import('openai');
  const Default = (mod as { default?: new (opts: { apiKey: string }) => OpenAIClient }).default;
  return Default ?? (mod as unknown as new (opts: { apiKey: string }) => OpenAIClient);
}

/** SDK `models.list()` がページネーション可能なため、最初の 1 ページのみで十分。 */
interface AnthropicClient {
  models: {
    list(): {
      // PagePromise は AsyncIterable<ModelInfo>
      [Symbol.asyncIterator](): AsyncIterator<{ id: string }>;
    };
  };
}
interface OpenAIClient {
  models: {
    list(): {
      [Symbol.asyncIterator](): AsyncIterator<{ id: string }>;
    };
  };
}

async function collectSdkModelIds(
  client: AnthropicClient | OpenAIClient,
  _provider: 'anthropic' | 'openai',
): Promise<string[]> {
  const ids: string[] = [];
  const iter = client.models.list();
  // 最大 200 件まで安全に取り切る (上限ガード)
  let count = 0;
  for await (const m of iter as AsyncIterable<{ id: string }>) {
    if (typeof m?.id === 'string') ids.push(m.id);
    count++;
    if (count >= 200) break;
  }
  return ids;
}

interface GoogleModelInfo {
  name?: string;
}
interface GoogleModelsListResponse {
  models?: GoogleModelInfo[];
  nextPageToken?: string;
}

async function listGoogleModels(
  fetchImpl: typeof globalThis.fetch,
  apiKey: string,
): Promise<string[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`google models.list HTTP ${res.status}`);
  }
  const json = (await res.json()) as GoogleModelsListResponse;
  const ids: string[] = [];
  for (const m of json.models ?? []) {
    if (typeof m.name === 'string') {
      // 'models/gemini-2.5-pro' → 'gemini-2.5-pro'
      ids.push(m.name.replace(/^models\//, ''));
    }
  }
  return ids;
}

async function safeFetchText(
  fetchImpl: typeof globalThis.fetch,
  url: string,
): Promise<string> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`pricing page HTTP ${res.status} for ${url}`);
  return await res.text();
}

// ---------------------------------------------------------------------------
// cheerio パーサ (provider 別)
//   - HTML 構造は変動するため「broken でも一部成功」を許容する設計。
//   - 価格表は概ね <table> または「$X.XX / 1M tokens」形式のテキストで出るので、
//     正規表現ベースで anchor (モデル ID) → 直近の数値ペアを拾う方式。
//   - 単価が抽出できなかったモデルは結果に含めない (= ok と判定するには 1 件以上必要)。
//
// cheerio は本番 fetcher (default*Fetcher) からのみ使われる。tsc で型を引かずに済むよう
// 動的 import + 最小ローカル型で参照する。
// ---------------------------------------------------------------------------

interface CheerioStaticLike {
  load(html: string): (selector: string) => { text(): string };
}

const PRICE_REGEX = /\$\s*(\d+(?:\.\d+)?)/g;

async function loadCheerio(): Promise<CheerioStaticLike> {
  // @ts-ignore — cheerio は本番のみ必要 (apps/worker/package.json で declare)。
  //   未インストール状態でも tsc を通すために型解決を無効化する (インストール後も同じく無視で問題ない)。
  const mod = await import('cheerio');
  return mod as unknown as CheerioStaticLike;
}

/**
 * pricing ページの HTML から body テキストだけ抜き出す共通ヘルパ。
 * cheerio はサーバ側 HTML パーサで script/style を text() から除外できる。
 */
async function extractBodyText(html: string): Promise<string> {
  const cheerio = await loadCheerio();
  const $ = cheerio.load(html);
  return $('body').text().replace(/\s+/g, ' ');
}

/**
 * Anthropic pricing ページから (model_id, input_usd, output_usd) を抽出。
 *
 * 戦略: ページ全体のテキストを model id 出現位置で区切り、各セクションから
 * 最初に現れる 2 つの $X.XX を input/output と解釈する。HTML 変更耐性のための保守的 fallback。
 */
async function parseAnthropicPricing(
  html: string,
  candidateModels: string[],
): Promise<ProviderPricingEntry[]> {
  const text = await extractBodyText(html);
  return parseGenericPricingByModelAnchors(text, candidateModels);
}

async function parseOpenAIPricing(
  html: string,
  candidateModels: string[],
): Promise<ProviderPricingEntry[]> {
  const text = await extractBodyText(html);
  return parseGenericPricingByModelAnchors(text, candidateModels);
}

async function parseGooglePricing(
  html: string,
  candidateModels: string[],
): Promise<ProviderPricingEntry[]> {
  const text = await extractBodyText(html);
  return parseGenericPricingByModelAnchors(text, candidateModels);
}

/**
 * 共通: text 全体から各 model id の出現位置を探し、その直後に現れる
 * 最初の 2 つの $X.XX を input/output 単価と解釈する。
 * model id がページに無ければそのモデルは skip。
 */
function parseGenericPricingByModelAnchors(
  text: string,
  candidateModels: string[],
): ProviderPricingEntry[] {
  const out: ProviderPricingEntry[] = [];
  const seen = new Set<string>();
  for (const model of candidateModels) {
    if (seen.has(model)) continue;
    const idx = text.indexOf(model);
    if (idx < 0) continue;
    // model 出現位置から 800 char ウィンドウで価格を拾う
    const window = text.slice(idx, idx + 800);
    const prices: number[] = [];
    PRICE_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PRICE_REGEX.exec(window)) !== null) {
      const v = Number.parseFloat(m[1]!);
      if (Number.isFinite(v) && v > 0) prices.push(v);
      if (prices.length >= 2) break;
    }
    if (prices.length < 2) continue;
    out.push({
      model,
      input_price_per_mtok_usd: prices[0]!,
      output_price_per_mtok_usd: prices[1]!,
    });
    seen.add(model);
  }
  return out;
}

// ---------------------------------------------------------------------------
// graphile-worker Task 本体 (薄ラッパ)
// ---------------------------------------------------------------------------

export const catalogFetchTask: Task = async (_payload: unknown, _helpers: JobHelpers) => {
  await runCatalogFetch();
};
