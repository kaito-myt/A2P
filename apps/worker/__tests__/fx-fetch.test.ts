import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@a2p/contracts/logger';
import { Prisma } from '@a2p/db';

import {
  FX_FETCH_TASK_NAME,
  runFxFetch,
  type FxFetchPrisma,
} from '../src/tasks/fx-fetch.js';

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
  const logger = {
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  return { logger, calls };
}

interface PrismaCaptures {
  appSettingsUpdate: Array<{
    where: { id: string };
    data: { latest_fx_rate: Prisma.Decimal };
  }>;
  alertCreate: Array<{
    data: {
      kind: string;
      severity: string;
      payload_json: Record<string, unknown>;
    };
  }>;
}

function makePrismaMock(): { prisma: FxFetchPrisma; captures: PrismaCaptures } {
  const captures: PrismaCaptures = {
    appSettingsUpdate: [],
    alertCreate: [],
  };
  const prisma: FxFetchPrisma = {
    appSettings: {
      update: async (args) => {
        captures.appSettingsUpdate.push(args);
        return { id: args.where.id };
      },
    },
    alert: {
      create: async (args) => {
        captures.alertCreate.push(args as PrismaCaptures['alertCreate'][number]);
        return { id: 'alert-id' };
      },
    },
  };
  return { prisma, captures };
}

/** open.er-api.com v6 形状の `Response` mock を作る。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fx.fetch task', () => {
  it('task identifier が docs/05 §5.3.13 と一致する', () => {
    expect(FX_FETCH_TASK_NAME).toBe('fx.fetch');
  });

  it('API 成功 → AppSettings.latest_fx_rate を Decimal で更新し Alert は INSERT しない', async () => {
    const { logger, calls } = makeLogger();
    const { prisma, captures } = makePrismaMock();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        result: 'success',
        base_code: 'USD',
        rates: { JPY: 150.12, EUR: 0.92 },
        time_last_update_unix: 1_700_000_000,
      }),
    );

    const result = await runFxFetch({
      prisma,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      apiUrl: 'https://open.er-api.com/v6/latest/USD',
      logger,
      now: () => new Date('2026-05-22T18:55:00Z'),
    });

    expect(result.ok).toBe(true);
    expect(result.rate).toBe(150.12);
    expect(result.apiUpdatedAt).toBe(1_700_000_000);

    // appSettings.update が 1 回、Alert は 0 回
    expect(captures.appSettingsUpdate).toHaveLength(1);
    expect(captures.alertCreate).toHaveLength(0);

    const update = captures.appSettingsUpdate[0]!;
    expect(update.where).toEqual({ id: 'singleton' });
    // Prisma.Decimal で正しい値が渡る (比較は文字列化で行う)
    expect(update.data.latest_fx_rate).toBeInstanceOf(Prisma.Decimal);
    expect(update.data.latest_fx_rate.toString()).toBe('150.12');

    // done ログに rate と apiUpdatedAtIso が含まれる
    const done = calls.find((c) => c.msg === 'fx fetch done');
    expect(done).toBeDefined();
    expect(done!.obj).toMatchObject({ rate: 150.12, apiUpdatedAt: 1_700_000_000 });
  });

  it('HTTP 500 → AppSettings 更新せず Alert(fx_fetch_failed) を INSERT', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = makePrismaMock();
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 500 }),
    );

    const result = await runFxFetch({
      prisma,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      apiUrl: 'https://open.er-api.com/v6/latest/USD',
      logger,
      now: () => new Date('2026-05-22T18:55:00Z'),
    });

    expect(result.ok).toBe(false);
    expect(result.rate).toBeNull();
    expect(captures.appSettingsUpdate).toHaveLength(0);
    expect(captures.alertCreate).toHaveLength(1);
    const alert = captures.alertCreate[0]!;
    expect(alert.data.kind).toBe('fx_fetch_failed');
    expect(alert.data.severity).toBe('warning');
    expect(alert.data.payload_json).toMatchObject({
      reason: 'http_error_500',
      http_status: 500,
      api_url: 'https://open.er-api.com/v6/latest/USD',
    });
  });

  it('network error (fetch reject) → AppSettings 更新せず Alert(fx_fetch_failed) を INSERT', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = makePrismaMock();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    });

    const result = await runFxFetch({
      prisma,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      apiUrl: 'https://open.er-api.com/v6/latest/USD',
      logger,
      now: () => new Date('2026-05-22T18:55:00Z'),
    });

    expect(result.ok).toBe(false);
    expect(captures.appSettingsUpdate).toHaveLength(0);
    expect(captures.alertCreate).toHaveLength(1);
    expect(captures.alertCreate[0]!.data.payload_json).toMatchObject({
      reason: 'network_error',
    });
  });

  it('JSON parse error → AppSettings 更新せず Alert(fx_fetch_failed) を INSERT', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = makePrismaMock();
    const fetchImpl = vi.fn(
      async () =>
        new Response('not a json {{{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const result = await runFxFetch({
      prisma,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      apiUrl: 'https://open.er-api.com/v6/latest/USD',
      logger,
      now: () => new Date('2026-05-22T18:55:00Z'),
    });

    expect(result.ok).toBe(false);
    expect(captures.appSettingsUpdate).toHaveLength(0);
    expect(captures.alertCreate).toHaveLength(1);
    expect(captures.alertCreate[0]!.data.payload_json).toMatchObject({
      reason: 'json_parse_error',
    });
  });

  it('result: "error" → AppSettings 更新せず Alert(fx_fetch_failed) を INSERT', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = makePrismaMock();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        result: 'error',
        'error-type': 'invalid-key',
      }),
    );

    const result = await runFxFetch({
      prisma,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      apiUrl: 'https://open.er-api.com/v6/latest/USD',
      logger,
      now: () => new Date('2026-05-22T18:55:00Z'),
    });

    expect(result.ok).toBe(false);
    expect(captures.appSettingsUpdate).toHaveLength(0);
    expect(captures.alertCreate).toHaveLength(1);
    expect(captures.alertCreate[0]!.data.payload_json).toMatchObject({
      reason: 'api_error_error',
    });
  });

  it('rates.JPY 欠落 → AppSettings 更新せず Alert(fx_fetch_failed) を INSERT', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = makePrismaMock();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        result: 'success',
        base_code: 'USD',
        // JPY なし — 他通貨だけ
        rates: { EUR: 0.92, GBP: 0.79 },
        time_last_update_unix: 1_700_000_000,
      }),
    );

    const result = await runFxFetch({
      prisma,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      apiUrl: 'https://open.er-api.com/v6/latest/USD',
      logger,
      now: () => new Date('2026-05-22T18:55:00Z'),
    });

    expect(result.ok).toBe(false);
    expect(captures.appSettingsUpdate).toHaveLength(0);
    expect(captures.alertCreate).toHaveLength(1);
    expect(captures.alertCreate[0]!.data.payload_json).toMatchObject({
      reason: 'missing_jpy_rate',
    });
  });

  it('rates.JPY が 0 や負数等の異常値 → 失敗扱い', async () => {
    const { logger } = makeLogger();
    const { prisma, captures } = makePrismaMock();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        result: 'success',
        base_code: 'USD',
        rates: { JPY: 0 },
        time_last_update_unix: 1_700_000_000,
      }),
    );

    const result = await runFxFetch({
      prisma,
      fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
      apiUrl: 'https://open.er-api.com/v6/latest/USD',
      logger,
      now: () => new Date('2026-05-22T18:55:00Z'),
    });

    expect(result.ok).toBe(false);
    expect(captures.appSettingsUpdate).toHaveLength(0);
    expect(captures.alertCreate).toHaveLength(1);
    expect(captures.alertCreate[0]!.data.payload_json).toMatchObject({
      reason: 'missing_jpy_rate',
    });
  });

  it('失敗時に throw しない (graphile-worker のリトライに乗せない設計)', async () => {
    const { logger } = makeLogger();
    const { prisma } = makePrismaMock();
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(
      runFxFetch({
        prisma,
        fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
        apiUrl: 'https://open.er-api.com/v6/latest/USD',
        logger,
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});
