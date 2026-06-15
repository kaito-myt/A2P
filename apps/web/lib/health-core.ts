/**
 * /api/health の純粋ロジック (T-01-12 後付け / SP-01 §6 #4 完了判定)。
 *
 * Prisma クライアントへの依存を DI で切り出し、route handler 側で実 prisma を、
 * テスト側で mock prisma を差し込めるようにする。
 *
 * 仕様:
 *  - DB に `SELECT 1` を投げ、成功なら ok:true / db:'ok'
 *  - 失敗 (接続切れ / 認証エラー等) なら ok:false / db:'error' + error message
 *  - HTTP ステータスは route 側で 200 / 503 に振り分ける
 */

export interface HealthCheckPrisma {
  $queryRaw: (
    template: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown>;
}

export interface HealthOk {
  ok: true;
  db: 'ok';
}

export interface HealthError {
  ok: false;
  db: 'error';
  error: string;
}

export type HealthResult = HealthOk | HealthError;

export async function checkHealth(prisma: HealthCheckPrisma): Promise<HealthResult> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, db: 'ok' };
  } catch (err) {
    return {
      ok: false,
      db: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
