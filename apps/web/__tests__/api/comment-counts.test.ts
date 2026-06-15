/**
 * comment-counts-core.ts のユニットテスト (T-06-12).
 *
 * 検証:
 *  - 正常時に { pending, must } 形状を返す
 *  - must は常に pending 以下 (部分集合)
 *  - マッチなし → { pending: 0, must: 0 }
 *  - pending > 0, must = 0 のケース
 *  - pending > must > 0 のケース
 *
 * Route Handler (route.ts) は NextAuth + prisma に依存する統合層。
 * カウントロジック自体は本ファイルで網羅する。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  getCommentCounts,
  type CommentCountsPrisma,
} from '../../lib/comment-counts-core';

function makePrisma(
  pendingCount: number,
  mustCount: number,
): CommentCountsPrisma {
  const countFn = vi.fn(
    async (args: { where: Record<string, unknown> }): Promise<number> => {
      if (args.where.priority === 'must') return mustCount;
      return pendingCount;
    },
  );
  return { revisionComment: { count: countFn } };
}

describe('getCommentCounts', () => {
  it('正しい { pending, must } 形状を返す', async () => {
    const prisma = makePrisma(5, 2);
    const result = await getCommentCounts(prisma);

    expect(result).toEqual({ pending: 5, must: 2 });
    expect(result).toHaveProperty('pending');
    expect(result).toHaveProperty('must');
  });

  it('must は常に pending 以下 (must は pending の部分集合)', async () => {
    const prisma = makePrisma(10, 3);
    const result = await getCommentCounts(prisma);

    expect(result.must).toBeLessThanOrEqual(result.pending);
  });

  it('マッチなし → { pending: 0, must: 0 }', async () => {
    const prisma = makePrisma(0, 0);
    const result = await getCommentCounts(prisma);

    expect(result).toEqual({ pending: 0, must: 0 });
  });

  it('pending > 0, must = 0 (should/may コメントのみ)', async () => {
    const prisma = makePrisma(7, 0);
    const result = await getCommentCounts(prisma);

    expect(result).toEqual({ pending: 7, must: 0 });
    expect(result.must).toBe(0);
    expect(result.pending).toBeGreaterThan(0);
  });

  it('pending = must (全て must コメント)', async () => {
    const prisma = makePrisma(4, 4);
    const result = await getCommentCounts(prisma);

    expect(result).toEqual({ pending: 4, must: 4 });
    expect(result.must).toBeLessThanOrEqual(result.pending);
  });

  it('count を status / priority の正しい where 条件で呼ぶ', async () => {
    const countFn = vi.fn(async () => 0);
    const prisma: CommentCountsPrisma = {
      revisionComment: { count: countFn },
    };

    await getCommentCounts(prisma);

    expect(countFn).toHaveBeenCalledTimes(2);
    expect(countFn).toHaveBeenCalledWith({ where: { status: 'pending' } });
    expect(countFn).toHaveBeenCalledWith({
      where: { status: 'pending', priority: 'must' },
    });
  });
});
