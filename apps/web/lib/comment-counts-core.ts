/**
 * /api/comments/counts の純粋ロジック (T-06-12).
 *
 * Prisma クライアントへの依存を DI で切り出し、route handler 側で実 prisma を、
 * テスト側で mock prisma を差し込めるようにする。
 *
 * 仕様:
 *  - pending: status='pending' の RevisionComment 件数
 *  - must: status='pending' かつ priority='must' の RevisionComment 件数
 *  - must は常に pending 以下 (部分集合)
 */

export interface CommentCountsPrisma {
  revisionComment: {
    count: (args: { where: Record<string, unknown> }) => Promise<number>;
  };
}

export interface CommentCountsResult {
  pending: number;
  must: number;
}

export async function getCommentCounts(
  prisma: CommentCountsPrisma,
): Promise<CommentCountsResult> {
  const [pending, must] = await Promise.all([
    prisma.revisionComment.count({ where: { status: 'pending' } }),
    prisma.revisionComment.count({
      where: { status: 'pending', priority: 'must' },
    }),
  ]);

  return { pending, must };
}
