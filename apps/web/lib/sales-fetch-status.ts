/**
 * RSC 用 SalesFetchRun 取得ヘルパ (T-12-06, F-038).
 *
 * S-017 ページの RSC 側から呼び出し、最新の SalesFetchRun を props に渡す。
 * サーバーサイド専用（'use client' 禁止 — prisma を import する）。
 *
 * クライアント安全な型・純関数（SalesFetchRunSerialized / serializeSalesFetchRun /
 * formatRelativeTime）は `sales-fetch-view.ts` に分離し、後方互換のため re-export する。
 *
 * 仕様根拠: SP-12 T-12-06 §2 "RSC 用ヘルパ", SP-12 T-12-07
 */
import { prisma, type SalesFetchRun } from '@a2p/db';

export {
  serializeSalesFetchRun,
  formatRelativeTime,
  type SalesFetchRunSerialized,
} from './sales-fetch-view';

/**
 * 指定アカウントの最新 SalesFetchRun を返す。
 * 存在しない場合は null を返す。
 */
export async function getLatestSalesFetchRun(
  accountId: string,
): Promise<SalesFetchRun | null> {
  return prisma.salesFetchRun.findFirst({
    where: { account_id: accountId },
    orderBy: { started_at: 'desc' },
  });
}
