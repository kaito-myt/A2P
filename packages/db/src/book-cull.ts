/**
 * 低品質本の間引き — 売上低迷の候補抽出クエリ + 判定純関数。
 *
 * 「公開後 min_age_days を経過し、累計 KENP と累計ロイヤリティがともに閾値以下」の
 * 出版済み書籍を取り下げ候補とする。破壊的操作(取り下げ)はレビュー承認式なので、
 * ここでは候補の抽出のみ行う(実際の状態遷移はワーカータスクが担う)。
 */
import type { PrismaClient } from '../generated/index.js';

export interface BookCullThresholds {
  minAgeDays: number;
  maxKenp: number;
  maxRoyaltyJpy: number;
}

export interface BookCullCandidate {
  book_id: string;
  title: string;
  asin: string | null;
  account_id: string;
  done_at: Date | null;
  age_days: number;
  cum_kenp: number;
  cum_royalty_jpy: number;
  quality_score: number | null;
}

/** 1 冊が売上低迷=候補かの純判定(テスト用。SQL と同一ロジック)。 */
export function isCullCandidate(
  metrics: { ageDays: number; cumKenp: number; cumRoyaltyJpy: number },
  t: BookCullThresholds,
): boolean {
  return metrics.ageDays >= t.minAgeDays && metrics.cumKenp <= t.maxKenp && metrics.cumRoyaltyJpy <= t.maxRoyaltyJpy;
}

/**
 * 取り下げ候補の書籍を返す。
 * 対象: status='done'(出版パイプライン完了) かつ asin あり かつ 公開(done_at)から
 *       min_age_days 以上経過。既に cull_status が approved/rejected/taken_down、または
 *       status='retracted' の本は除外(再抽出しない)。
 */
export async function getBookCullCandidates(
  prisma: PrismaClient,
  t: BookCullThresholds,
  now: Date = new Date(),
): Promise<BookCullCandidate[]> {
  const cutoff = new Date(now.getTime() - t.minAgeDays * 24 * 60 * 60 * 1000);
  const sql = `
    WITH sales_cum AS (
      SELECT book_id,
        COALESCE(SUM(kenp_read), 0)::bigint   AS cum_kenp,
        COALESCE(SUM(royalty_jpy), 0)::bigint  AS cum_royalty
      FROM sales_records GROUP BY book_id
    ),
    eval_latest AS (
      SELECT DISTINCT ON (book_id) book_id, score_total
      FROM eval_results ORDER BY book_id, judged_at DESC
    )
    SELECT b.id AS book_id, b.title, b.asin, b.account_id, b.done_at,
      COALESCE(sc.cum_kenp, 0)::bigint    AS cum_kenp,
      COALESCE(sc.cum_royalty, 0)::bigint AS cum_royalty,
      el.score_total                      AS quality_score
    FROM books b
    LEFT JOIN sales_cum sc ON sc.book_id = b.id
    LEFT JOIN eval_latest el ON el.book_id = b.id
    WHERE b.status = 'done'
      AND b.asin IS NOT NULL
      AND b.done_at IS NOT NULL
      AND b.done_at <= $1
      AND COALESCE(b.cull_status, '') NOT IN ('approved', 'rejected', 'taken_down')
      AND COALESCE(sc.cum_kenp, 0) <= $2
      AND COALESCE(sc.cum_royalty, 0) <= $3
    ORDER BY COALESCE(sc.cum_royalty, 0) ASC, COALESCE(sc.cum_kenp, 0) ASC
  `;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (prisma.$queryRawUnsafe as any)(sql, cutoff, t.maxKenp, t.maxRoyaltyJpy)) as Record<string, unknown>[];
  return rows.map((r) => {
    const doneAt = r['done_at'] ? new Date(r['done_at'] as string) : null;
    const ageDays = doneAt ? Math.floor((now.getTime() - doneAt.getTime()) / (24 * 60 * 60 * 1000)) : 0;
    return {
      book_id: String(r['book_id']),
      title: String(r['title']),
      asin: r['asin'] ? String(r['asin']) : null,
      account_id: String(r['account_id']),
      done_at: doneAt,
      age_days: ageDays,
      cum_kenp: Number(r['cum_kenp'] ?? 0),
      cum_royalty_jpy: Number(r['cum_royalty'] ?? 0),
      quality_score: r['quality_score'] == null ? null : Number(r['quality_score']),
    };
  });
}
