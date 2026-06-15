/**
 * docs/05 §14 #8 — `Book.cost_jpy_total` を atomic に increment する。
 *
 * Prisma の `{ increment }` 修飾子は背後で `UPDATE ... SET cost_jpy_total = cost_jpy_total + $1`
 * を発行するため、行レベルロックにより並列呼出でも race condition なく加算される
 * (PostgreSQL の標準動作)。Book が存在しない (削除済み等) ケースは `P2025` を吐くが、
 * 呼び出し元の `withTokenLogging` が握りつぶす (INSERT 失敗と同様、運用継続を優先)。
 *
 * Decimal 型カラムへの加算なので `costJpy` は number または string で渡せる。
 * 高精度のため通常は文字列化 (`String(costJpy)`) を推奨するが、Prisma の Decimal
 * 受け口は number も受け入れるので、ここではそのまま渡す。
 */
import { prisma as defaultPrisma } from '@a2p/db';

export interface UpdateBookCostPrisma {
  book: {
    update(args: {
      where: { id: string };
      data: { cost_jpy_total: { increment: number } };
      select?: { cost_jpy_total: true };
    }): Promise<{ cost_jpy_total: unknown }>;
  };
}

/**
 * `Book.cost_jpy_total` に `costJpy` を atomic に加算する。
 * @returns 加算後の `cost_jpy_total` の数値表現 (Decimal → Number 変換済み)。
 */
export async function updateBookCost(
  bookId: string,
  costJpy: number,
  prismaClient: UpdateBookCostPrisma = defaultPrisma as unknown as UpdateBookCostPrisma,
): Promise<number> {
  const updated = await prismaClient.book.update({
    where: { id: bookId },
    data: { cost_jpy_total: { increment: costJpy } },
    select: { cost_jpy_total: true },
  });
  const v = updated.cost_jpy_total;
  if (typeof v === 'number') return v;
  // Prisma Decimal は toNumber() を持つ。string が来る場合は parseFloat。
  if (v != null && typeof (v as { toNumber?: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v);
}
