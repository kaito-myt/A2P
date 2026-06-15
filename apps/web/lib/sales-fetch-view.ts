/**
 * SalesFetchRun のクライアント安全なビューヘルパ (T-12-07, F-038).
 *
 * 本ファイルは **prisma を import しない**（型のみ）。'use client' コンポーネント
 * （sales-fetch-status-banner.tsx）から安全に import できる。サーバ専用の取得処理
 * （getLatestSalesFetchRun）は `sales-fetch-status.ts` 側に置く。
 *
 * 仕様根拠: SP-12 T-12-07。client/server 境界（@a2p/db = prisma が 'fs' を要求し
 * client バンドルでビルド不能になる問題）を避けるための分離。
 */
import type { SalesFetchRun } from '@a2p/db';

/**
 * SalesFetchRun を Client Component に渡せる形にシリアライズした型。
 * Date フィールドは ISO 文字列。
 */
export interface SalesFetchRunSerialized {
  id: string;
  account_id: string;
  year_month: string;
  status: string;
  records_upserted: number;
  error_message: string | null;
  started_at: string; // ISO
  finished_at: string | null; // ISO
}

/**
 * SalesFetchRun を Client Component に渡せる形にシリアライズする。
 * Date フィールドを ISO 文字列に変換する。
 * （`SalesFetchRun` は型のみ import のためビルド時に消える = client 安全）
 */
export function serializeSalesFetchRun(
  run: SalesFetchRun,
): SalesFetchRunSerialized {
  return {
    id: run.id,
    account_id: run.account_id,
    year_month: run.year_month,
    status: run.status,
    records_upserted: run.records_upserted,
    error_message: run.error_message,
    started_at: run.started_at.toISOString(),
    finished_at: run.finished_at?.toISOString() ?? null,
  };
}

/**
 * ISO 文字列を日本語の相対時刻に変換する。
 * 例: "5 分前", "3 時間前", "2 日前"
 */
export function formatRelativeTime(isoString: string, now: Date = new Date()): string {
  const diff = now.getTime() - new Date(isoString).getTime();
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 時間前`;
  const days = Math.floor(hours / 24);
  return `${days} 日前`;
}
