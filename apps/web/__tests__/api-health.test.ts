/**
 * /api/health の純粋ロジック checkHealth() のユニットテスト
 * (SP-01 §6 #4 完了判定 / Railway Healthcheck Path)
 *
 * 検証:
 *  - DB クエリが成功 → { ok: true, db: 'ok' } を返す
 *  - DB クエリが失敗 → { ok: false, db: 'error', error: '<message>' } を返す
 *
 * route.ts 自体は NextResponse + prisma を import するため統合層であり、
 * ステータスコード 200 / 503 の分岐は本コアの ok フラグから route 側で導出される。
 */
import { describe, expect, it, vi } from 'vitest';
import { checkHealth, type HealthCheckPrisma } from '../lib/health-core';

function makePrisma(impl: HealthCheckPrisma['$queryRaw']): HealthCheckPrisma {
  return { $queryRaw: impl };
}

describe('checkHealth', () => {
  it('DB が応答すれば { ok: true, db: "ok" } を返す (route 側で HTTP 200)', async () => {
    const queryRaw = vi.fn(async () => [{ '?column?': 1 }]);
    const prisma = makePrisma(queryRaw);

    const result = await checkHealth(prisma);

    expect(result).toEqual({ ok: true, db: 'ok' });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    // tagged template リテラル `SELECT 1` で呼ばれることを確認
    const firstCall = queryRaw.mock.calls[0] as unknown as
      | [TemplateStringsArray, ...unknown[]]
      | undefined;
    expect(firstCall).toBeDefined();
    expect(Array.from(firstCall![0])).toEqual(['SELECT 1']);
  });

  it('DB が例外を投げれば { ok: false, db: "error", error } を返す (route 側で HTTP 503)', async () => {
    const queryRaw = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const prisma = makePrisma(queryRaw);

    const result = await checkHealth(prisma);

    expect(result).toEqual({
      ok: false,
      db: 'error',
      error: 'connection refused',
    });
  });
});
