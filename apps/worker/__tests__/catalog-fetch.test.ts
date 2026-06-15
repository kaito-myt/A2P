import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@a2p/contracts/logger';
import { Prisma } from '@a2p/db';

import {
  CATALOG_FETCH_TASK_NAME,
  runCatalogFetch,
  type CatalogFetchDeps,
  type CatalogFetchPrisma,
  type Provider,
  type ProviderFetcher,
  type ProviderPricingEntry,
} from '../src/tasks/catalog-fetch.js';

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------

function makeLogger() {
  const calls: Array<{
    level: 'info' | 'warn' | 'error';
    obj: Record<string, unknown>;
    msg: string;
  }> = [];
  const mk = (level: 'info' | 'warn' | 'error') =>
    (obj: Record<string, unknown>, msg?: string) => {
      calls.push({ level, obj, msg: msg ?? '' });
    };
  const base = {
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger & { child?: (b: Record<string, unknown>) => Logger };
  // child は同じ collector を共有して返す (テストで provider タグを失わないため)
  (base as { child?: (b: Record<string, unknown>) => Logger }).child = () => base;
  return { logger: base as Logger, calls };
}

// ---------------------------------------------------------------------------
// Prisma mock
// ---------------------------------------------------------------------------

interface PrismaCaptures {
  appSettingsFindUnique: number;
  modelCatalogFindMany: Array<{
    where: { provider: string; model?: string; is_current?: boolean };
  }>;
  modelCatalogUpdateMany: Array<{
    where: { provider: string; model: { in: string[] }; is_current: boolean };
    data: { is_current: boolean };
  }>;
  modelCatalogCreate: Array<{
    data: {
      provider: string;
      model: string;
      input_price_per_mtok_usd: Prisma.Decimal;
      output_price_per_mtok_usd: Prisma.Decimal;
      image_price_per_image_usd: Prisma.Decimal | null;
      fx_rate_usd_jpy: Prisma.Decimal;
      fetched_at: Date;
      source: string;
      is_current: boolean;
    };
  }>;
  alertCreate: Array<{
    data: {
      kind: string;
      severity: string;
      payload_json: Record<string, unknown>;
    };
  }>;
}

interface PrismaMockOptions {
  /** is_current=true で返す既存行 (provider → entries)。 */
  existing?: Partial<
    Record<
      Provider,
      Array<{
        model: string;
        input_price_per_mtok_usd: number;
        output_price_per_mtok_usd: number;
        image_price_per_image_usd?: number | null;
      }>
    >
  >;
  /** AppSettings.latest_fx_rate。null なら fallback 150 が使われる。 */
  fxRate?: number | null;
}

function makePrismaMock(opts: PrismaMockOptions = {}): {
  prisma: CatalogFetchPrisma;
  captures: PrismaCaptures;
} {
  const captures: PrismaCaptures = {
    appSettingsFindUnique: 0,
    modelCatalogFindMany: [],
    modelCatalogUpdateMany: [],
    modelCatalogCreate: [],
    alertCreate: [],
  };
  const fxRate = opts.fxRate;
  const existingMap = opts.existing ?? {};

  const prisma: CatalogFetchPrisma = {
    appSettings: {
      findUnique: async (_args) => {
        captures.appSettingsFindUnique++;
        if (fxRate === undefined) {
          return { latest_fx_rate: new Prisma.Decimal(150.0) };
        }
        if (fxRate === null) {
          return { latest_fx_rate: null };
        }
        return { latest_fx_rate: new Prisma.Decimal(fxRate) };
      },
    },
    modelCatalog: {
      findMany: async (args) => {
        captures.modelCatalogFindMany.push(args);
        const entries = existingMap[args.where.provider as Provider] ?? [];
        return entries.map((e) => ({
          provider: args.where.provider,
          model: e.model,
          input_price_per_mtok_usd: new Prisma.Decimal(e.input_price_per_mtok_usd),
          output_price_per_mtok_usd: new Prisma.Decimal(e.output_price_per_mtok_usd),
          image_price_per_image_usd:
            e.image_price_per_image_usd != null ? new Prisma.Decimal(e.image_price_per_image_usd) : null,
          fx_rate_usd_jpy: new Prisma.Decimal(150),
          is_current: true,
        }));
      },
      updateMany: async (args) => {
        captures.modelCatalogUpdateMany.push(args);
        return { count: args.where.model.in.length };
      },
      create: async (args) => {
        captures.modelCatalogCreate.push(args as PrismaCaptures['modelCatalogCreate'][number]);
        return { id: `mc-${captures.modelCatalogCreate.length}` };
      },
    },
    alert: {
      create: async (args) => {
        captures.alertCreate.push(args as PrismaCaptures['alertCreate'][number]);
        return { id: `alert-${captures.alertCreate.length}` };
      },
    },
  };
  return { prisma, captures };
}

// ---------------------------------------------------------------------------
// Provider fetcher mocks
// ---------------------------------------------------------------------------

function okFetcher(provider: Provider, pricing: ProviderPricingEntry[]): ProviderFetcher {
  return async () => ({
    provider,
    ok: true,
    pricing,
    modelIdsFromSdk: pricing.map((p) => p.model),
    source: defaultSource(provider),
  });
}

function failFetcher(provider: Provider, reason: string): ProviderFetcher {
  return async () => ({
    provider,
    ok: false,
    source: defaultSource(provider),
    error: reason,
  });
}

function defaultSource(provider: Provider): string {
  switch (provider) {
    case 'anthropic':
      return 'anthropic_pricing_page_v1';
    case 'openai':
      return 'openai_pricing_v2';
    case 'google':
      return 'google_pricing_v1';
  }
}

function makeBaseDeps(
  overrides: Partial<CatalogFetchDeps> = {},
): CatalogFetchDeps & { sendEmailMock: ReturnType<typeof vi.fn> } {
  const sendEmailMock = vi.fn(async () => ({ id: 'mail-id' }));
  const deps: CatalogFetchDeps = {
    getApiKeyImpl: async () => 'sk-test',
    sendEmailImpl: sendEmailMock as unknown as CatalogFetchDeps['sendEmailImpl'],
    now: () => new Date('2026-05-22T19:00:00Z'),
    fetchImpl: vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof globalThis.fetch,
    ...overrides,
  };
  return Object.assign(deps, { sendEmailMock });
}

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

describe('catalog.fetch task', () => {
  it('task identifier が docs/05 §5.3.12 と一致する', () => {
    expect(CATALOG_FETCH_TASK_NAME).toBe('catalog.fetch');
  });

  it('3 provider 全成功 → ModelCatalog upsert 完了 / Alert 0 件', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = makePrismaMock({
      fxRate: 152.5,
      existing: {}, // 初回 (= 前回値なし)
    });
    const deps = makeBaseDeps({
      logger,
      prisma,
      providerFetchers: {
        anthropic: okFetcher('anthropic', [
          {
            model: 'claude-opus-4-7',
            input_price_per_mtok_usd: 15.0,
            output_price_per_mtok_usd: 75.0,
          },
          {
            model: 'claude-sonnet-4-6',
            input_price_per_mtok_usd: 3.0,
            output_price_per_mtok_usd: 15.0,
          },
        ]),
        openai: okFetcher('openai', [
          {
            model: 'gpt-4o',
            input_price_per_mtok_usd: 2.5,
            output_price_per_mtok_usd: 10.0,
          },
          {
            model: 'gpt-image-1',
            input_price_per_mtok_usd: 5.0,
            output_price_per_mtok_usd: 40.0,
            image_price_per_image_usd: 0.04,
          },
        ]),
        google: okFetcher('google', [
          {
            model: 'gemini-2.5-pro',
            input_price_per_mtok_usd: 1.25,
            output_price_per_mtok_usd: 10.0,
          },
        ]),
      },
    });

    const result = await runCatalogFetch(deps);

    expect(result.ok).toBe(true);
    expect(result.providers.anthropic.ok).toBe(true);
    expect(result.providers.openai.ok).toBe(true);
    expect(result.providers.google.ok).toBe(true);

    // 2 + 2 + 1 = 5 行 INSERT
    expect(captures.modelCatalogCreate).toHaveLength(5);
    // 各 INSERT に fx_rate 152.5 が反映されている
    for (const c of captures.modelCatalogCreate) {
      expect(c.data.fx_rate_usd_jpy.toString()).toBe('152.5');
      expect(c.data.is_current).toBe(true);
      expect(c.data.fetched_at.toISOString()).toBe('2026-05-22T19:00:00.000Z');
    }
    // image_price は OpenAI gpt-image-1 のみ非 null
    const gptImage = captures.modelCatalogCreate.find((c) => c.data.model === 'gpt-image-1');
    expect(gptImage!.data.image_price_per_image_usd!.toString()).toBe('0.04');
    const gpt4o = captures.modelCatalogCreate.find((c) => c.data.model === 'gpt-4o');
    expect(gpt4o!.data.image_price_per_image_usd).toBeNull();

    // source 文字列規約
    expect(
      captures.modelCatalogCreate.find((c) => c.data.provider === 'anthropic')!.data.source,
    ).toBe('anthropic_pricing_page_v1');
    expect(
      captures.modelCatalogCreate.find((c) => c.data.provider === 'openai')!.data.source,
    ).toBe('openai_pricing_v2');
    expect(
      captures.modelCatalogCreate.find((c) => c.data.provider === 'google')!.data.source,
    ).toBe('google_pricing_v1');

    // updateMany が 3 provider 分発火 (空の where.in でも呼ぶ)
    expect(captures.modelCatalogUpdateMany).toHaveLength(3);

    // Alert は 0 件 (初回 = 比較対象なし)
    expect(captures.alertCreate).toHaveLength(0);
    expect(deps.sendEmailMock).not.toHaveBeenCalled();
  });

  it('1 provider 失敗 → 他 2 provider のみ更新 / catalog_fetch_failed Alert 1 件', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = makePrismaMock({ fxRate: 150 });
    const deps = makeBaseDeps({
      logger,
      prisma,
      providerFetchers: {
        anthropic: okFetcher('anthropic', [
          {
            model: 'claude-opus-4-7',
            input_price_per_mtok_usd: 15.0,
            output_price_per_mtok_usd: 75.0,
          },
        ]),
        openai: failFetcher('openai', 'pricing_page_http_503'),
        google: okFetcher('google', [
          {
            model: 'gemini-2.5-pro',
            input_price_per_mtok_usd: 1.25,
            output_price_per_mtok_usd: 10.0,
          },
        ]),
      },
    });

    const result = await runCatalogFetch(deps);

    expect(result.ok).toBe(true); // 1 件でも成功すれば全体 ok
    expect(result.providers.anthropic.ok).toBe(true);
    expect(result.providers.openai.ok).toBe(false);
    expect(result.providers.openai.errorReason).toBe('pricing_page_http_503');
    expect(result.providers.google.ok).toBe(true);

    // 失敗した openai は ModelCatalog に INSERT されない / updateMany もされない
    expect(captures.modelCatalogCreate.find((c) => c.data.provider === 'openai')).toBeUndefined();
    expect(
      captures.modelCatalogUpdateMany.find((u) => u.where.provider === 'openai'),
    ).toBeUndefined();

    // 成功 provider は新行が入っている
    expect(captures.modelCatalogCreate.filter((c) => c.data.provider === 'anthropic')).toHaveLength(1);
    expect(captures.modelCatalogCreate.filter((c) => c.data.provider === 'google')).toHaveLength(1);

    // catalog_fetch_failed Alert が openai 分のみ 1 件
    const failedAlerts = captures.alertCreate.filter((a) => a.data.kind === 'catalog_fetch_failed');
    expect(failedAlerts).toHaveLength(1);
    expect(failedAlerts[0]!.data.payload_json).toMatchObject({
      provider: 'openai',
      error: 'pricing_page_http_503',
    });
    expect(failedAlerts[0]!.data.severity).toBe('warning');
  });

  it('±10% 超変動 → catalog_price_change Alert + pricing-changed メール送信', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = makePrismaMock({
      fxRate: 150,
      existing: {
        anthropic: [
          {
            model: 'claude-sonnet-4-6',
            input_price_per_mtok_usd: 3.0,
            output_price_per_mtok_usd: 15.0,
          },
        ],
      },
    });
    const deps = makeBaseDeps({
      logger,
      prisma,
      providerFetchers: {
        anthropic: okFetcher('anthropic', [
          {
            model: 'claude-sonnet-4-6',
            input_price_per_mtok_usd: 3.45, // +15% → 閾値超
            output_price_per_mtok_usd: 15.0,
          },
        ]),
        openai: okFetcher('openai', []),
        google: okFetcher('google', []),
      },
    });

    const result = await runCatalogFetch(deps);

    // openai/google は空の pricing なので失敗扱い → anthropic のみ ok
    expect(result.providers.anthropic.ok).toBe(true);
    expect(result.providers.anthropic.priceChangeAlertCount).toBe(1);

    // price_change Alert が 1 件
    const priceAlerts = captures.alertCreate.filter((a) => a.data.kind === 'catalog_price_change');
    expect(priceAlerts).toHaveLength(1);
    const payload = priceAlerts[0]!.data.payload_json as Record<string, unknown>;
    expect(payload.provider).toBe('anthropic');
    expect(payload.model).toBe('claude-sonnet-4-6');
    expect((payload.before as Record<string, unknown>).input_price_per_mtok_usd).toBe(3.0);
    expect((payload.after as Record<string, unknown>).input_price_per_mtok_usd).toBe(3.45);
    const deltaPct = payload.delta_pct as Record<string, number>;
    expect(deltaPct.input).toBeGreaterThan(14); // 約 +15%
    expect(deltaPct.input).toBeLessThan(16);

    // pricing-changed メールが 1 回送信される
    expect(deps.sendEmailMock).toHaveBeenCalledTimes(1);
    const mailArg = deps.sendEmailMock.mock.calls[0]![0] as { subject: string };
    expect(mailArg.subject).toContain('モデル単価');
  });

  it('±10% 未満の変動では alert 発火しない (6.7% 増)', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = makePrismaMock({
      fxRate: 150,
      existing: {
        anthropic: [
          {
            model: 'claude-sonnet-4-6',
            input_price_per_mtok_usd: 3.0,
            output_price_per_mtok_usd: 15.0,
          },
        ],
      },
    });
    const deps = makeBaseDeps({
      logger,
      prisma,
      providerFetchers: {
        anthropic: okFetcher('anthropic', [
          {
            model: 'claude-sonnet-4-6',
            input_price_per_mtok_usd: 3.2, // +6.67% (閾値 10% 未満)
            output_price_per_mtok_usd: 15.0,
          },
        ]),
        openai: okFetcher('openai', []),
        google: okFetcher('google', []),
      },
    });

    await runCatalogFetch(deps);

    expect(captures.alertCreate.filter((a) => a.data.kind === 'catalog_price_change')).toHaveLength(0);
    expect(deps.sendEmailMock).not.toHaveBeenCalled();
  });

  it('初回 (前回値なし) は alert 発火しない', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = makePrismaMock({
      fxRate: 150,
      existing: {}, // anthropic は existing 0 件
    });
    const deps = makeBaseDeps({
      logger,
      prisma,
      providerFetchers: {
        anthropic: okFetcher('anthropic', [
          {
            model: 'claude-opus-4-7',
            input_price_per_mtok_usd: 999.0,
            output_price_per_mtok_usd: 9999.0,
          },
        ]),
        openai: okFetcher('openai', []),
        google: okFetcher('google', []),
      },
    });

    await runCatalogFetch(deps);

    expect(captures.alertCreate.filter((a) => a.data.kind === 'catalog_price_change')).toHaveLength(0);
    expect(deps.sendEmailMock).not.toHaveBeenCalled();
    // ただし新規 INSERT は 1 件
    expect(captures.modelCatalogCreate).toHaveLength(1);
  });

  it('AppSettings.latest_fx_rate が null なら fallback 150 を使用', async () => {
    const { logger, calls } = makeLogger();
    const { prisma, captures } = makePrismaMock({ fxRate: null });
    const deps = makeBaseDeps({
      logger,
      prisma,
      providerFetchers: {
        anthropic: okFetcher('anthropic', [
          {
            model: 'claude-opus-4-7',
            input_price_per_mtok_usd: 15.0,
            output_price_per_mtok_usd: 75.0,
          },
        ]),
        openai: okFetcher('openai', []),
        google: okFetcher('google', []),
      },
    });

    await runCatalogFetch(deps);

    expect(captures.modelCatalogCreate).toHaveLength(1);
    expect(captures.modelCatalogCreate[0]!.data.fx_rate_usd_jpy.toString()).toBe('150');

    const warned = calls.find((c) => c.msg.includes('fallback'));
    expect(warned).toBeDefined();
  });

  it('全 provider 失敗でも throw せず { ok: false } を返す (運用継続優先)', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = makePrismaMock({ fxRate: 150 });
    const deps = makeBaseDeps({
      logger,
      prisma,
      providerFetchers: {
        anthropic: failFetcher('anthropic', 'network_error'),
        openai: failFetcher('openai', 'network_error'),
        google: failFetcher('google', 'network_error'),
      },
    });

    const result = await runCatalogFetch(deps);

    expect(result.ok).toBe(false);
    expect(captures.modelCatalogCreate).toHaveLength(0);
    // 3 つの catalog_fetch_failed alert
    expect(captures.alertCreate.filter((a) => a.data.kind === 'catalog_fetch_failed')).toHaveLength(3);
  });

  it('getApiKey が throw した provider は skip され catalog_fetch_failed alert が出る', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = makePrismaMock({ fxRate: 150 });
    const deps = makeBaseDeps({
      logger,
      prisma,
      getApiKeyImpl: async (p: Provider) => {
        if (p === 'google') throw new Error('GOOGLE_GENERATIVE_AI_API_KEY missing');
        return 'sk-test';
      },
      providerFetchers: {
        anthropic: okFetcher('anthropic', [
          {
            model: 'claude-opus-4-7',
            input_price_per_mtok_usd: 15.0,
            output_price_per_mtok_usd: 75.0,
          },
        ]),
        openai: okFetcher('openai', [
          {
            model: 'gpt-4o',
            input_price_per_mtok_usd: 2.5,
            output_price_per_mtok_usd: 10.0,
          },
        ]),
        // google fetcher は呼ばれない (api key で先に失敗)
        google: okFetcher('google', [
          {
            model: 'gemini-2.5-pro',
            input_price_per_mtok_usd: 1.25,
            output_price_per_mtok_usd: 10.0,
          },
        ]),
      },
    });

    const result = await runCatalogFetch(deps);

    expect(result.providers.anthropic.ok).toBe(true);
    expect(result.providers.openai.ok).toBe(true);
    expect(result.providers.google.ok).toBe(false);
    expect(result.providers.google.errorReason).toContain('api_key_missing');

    // google 用の catalog_fetch_failed alert が 1 件
    const failedAlerts = captures.alertCreate.filter(
      (a) => a.data.kind === 'catalog_fetch_failed' && (a.data.payload_json as { provider: string }).provider === 'google',
    );
    expect(failedAlerts).toHaveLength(1);
  });

  it('fetcher が予期せず throw しても全体は継続し catalog_fetch_failed alert を出す', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = makePrismaMock({ fxRate: 150 });
    const deps = makeBaseDeps({
      logger,
      prisma,
      providerFetchers: {
        anthropic: okFetcher('anthropic', [
          {
            model: 'claude-opus-4-7',
            input_price_per_mtok_usd: 15.0,
            output_price_per_mtok_usd: 75.0,
          },
        ]),
        openai: async () => {
          throw new TypeError('unexpected boom');
        },
        google: okFetcher('google', []),
      },
    });

    const result = await runCatalogFetch(deps);

    expect(result.providers.anthropic.ok).toBe(true);
    expect(result.providers.openai.ok).toBe(false);
    expect(result.providers.openai.errorReason).toContain('unexpected boom');
    // openai 用 catalog_fetch_failed alert が 1 件
    const failed = captures.alertCreate.filter(
      (a) =>
        a.data.kind === 'catalog_fetch_failed' &&
        (a.data.payload_json as { provider: string }).provider === 'openai',
    );
    expect(failed).toHaveLength(1);
  });
});
