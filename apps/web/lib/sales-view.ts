/**
 * S-018 売上手動入力 RSC シリアライザ (T-08-06, F-037).
 *
 * Prisma Book / SalesRecord を Client Component に渡せる plain-object に変換する。
 *
 * 仕様根拠: docs/04 S-018 / SP-08 T-08-06
 */

// ---------------------------------------------------------------------------
// Book selector view
// ---------------------------------------------------------------------------

export interface BookSelectorItem {
  id: string;
  title: string;
  /** ASIN (null = 未発行) */
  asin: string | null;
  /** 検索用ラベル: "タイトル (ASIN)" or "タイトル" */
  label: string;
}

export function serializeBookSelectorItems(
  books: Array<{ id: string; title: string; asin: string | null }>,
): BookSelectorItem[] {
  return books.map((b) => ({
    id: b.id,
    title: b.title,
    asin: b.asin,
    label: b.asin ? `${b.title} (${b.asin})` : b.title,
  }));
}

// ---------------------------------------------------------------------------
// Sales history view (past 6 months)
// ---------------------------------------------------------------------------

export interface SalesHistoryRow {
  year_month: string;
  /** ロイヤリティ (JPY) */
  royalty_jpy: number;
  review_count: number;
  /** avg_stars — null if not recorded */
  avg_stars: number | null;
}

export interface SalesHistoryData {
  book_id: string;
  book_title: string;
  rows: SalesHistoryRow[];
}

export function serializeSalesHistory(
  book: { id: string; title: string },
  records: Array<{
    year_month: string;
    royalty_jpy: number;
    review_count: number;
    avg_stars: { toNumber(): number } | number | null | undefined;
  }>,
): SalesHistoryData {
  return {
    book_id: book.id,
    book_title: book.title,
    rows: records.map((r) => ({
      year_month: r.year_month,
      royalty_jpy: r.royalty_jpy,
      review_count: r.review_count,
      avg_stars: r.avg_stars == null
        ? null
        : typeof r.avg_stars === 'object'
          ? r.avg_stars.toNumber()
          : (r.avg_stars as number),
    })),
  };
}

// ---------------------------------------------------------------------------
// Template CSV
// ---------------------------------------------------------------------------

/** テンプレート CSV コンテンツ (ヘッダ + サンプル行) を返す。 */
export function buildSalesTemplateCsv(): string {
  // 先頭列は asin / title / book_id のいずれでも可。KDP レポートに合わせ asin を既定にする。
  const header = 'asin,year_month,royalty_jpy,review_count,avg_stars,bsr';
  const example = 'B0XXXXXXXX,2026-05,1500,12,4.3,12345';
  return `${header}\n${example}\n`;
}

export function buildSalesTemplateCsvFilename(): string {
  return 'sales-import-template.csv';
}
