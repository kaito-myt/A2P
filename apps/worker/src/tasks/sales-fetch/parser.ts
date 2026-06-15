import { load } from 'cheerio';

/**
 * KDP レポートページのパース結果（1 書籍 × 1 月分）。
 * docs/05 §5.3.14 / SP-12 T-12-02 参照。
 */
export interface KdpSalesRow {
  asin: string;
  year_month: string; // "YYYY-MM"
  royalty_jpy: number;
  units_sold: number;
  review_count: number;
  avg_stars: number | null;
  bsr: number | null;
}

/**
 * Amazon 商品ページから抽出した補助データ。
 */
export interface KdpPublicPageData {
  bsr: number | null;
  avg_stars: number | null;
  review_count: number | null;
}

/**
 * KDP レポートHTMLから売上行を抽出する純関数。
 * 実ブラウザ不使用。Vitest で fixture HTML を渡してテスト可能。
 *
 * 設計原則:
 * - throw しない（パース失敗は空配列 or 部分成功で返す）
 * - HTML 構造の変化に対し保守的（1 行でも取れれば ok）
 * - KDP は日本語 UI を前提とする（円建て / 「レビュー」ラベル）
 */
export function parseKdpSalesHtml(html: string, yearMonth: string): KdpSalesRow[] {
  try {
    const $ = load(html);
    const rows: KdpSalesRow[] = [];

    $('tr.report-row').each((_i, el) => {
      try {
        const row = $(el);
        const asin = extractAsin(row.attr('data-asin') ?? row.find('.asin-cell').text().trim());
        if (!asin) return;

        const royalty_jpy = parseRoyaltyJpy(row.find('.royalty-cell').text().trim());
        const units_sold = parseUnits(row.find('.units-cell').text().trim());
        const review_count = parseReviewCount(row.find('.reviews-cell').text().trim());
        const avg_stars = parseAvgStars(row.find('.stars-cell').text().trim());

        rows.push({
          asin,
          year_month: yearMonth,
          royalty_jpy,
          units_sold,
          review_count,
          avg_stars,
          bsr: null,
        });
      } catch {
        // 行パース失敗は skip して継続
      }
    });

    return rows;
  } catch {
    return [];
  }
}

/**
 * Amazon 書籍ページの HTML から BSR と平均星・レビュー数を抽出する純関数（補助）。
 * throw しない（失敗は null フィールドで返す）。
 */
export function parseAmazonPublicPage(html: string): KdpPublicPageData {
  try {
    const $ = load(html);

    const avg_stars = parseAvgStarsFromPage($);
    const review_count = parseReviewCountFromPage($);
    const bsr = parseBsrFromPage($);

    return { bsr, avg_stars, review_count };
  } catch {
    return { bsr: null, avg_stars: null, review_count: null };
  }
}

// ---------------------------------------------------------------------------
// 内部ヘルパ
// ---------------------------------------------------------------------------

/** ASIN が B0 で始まる 10 文字の英数字かを検証して返す。不正なら null。 */
function extractAsin(raw: string): string | null {
  const cleaned = raw.trim();
  if (/^B0[A-Z0-9]{8}$/i.test(cleaned)) return cleaned.toUpperCase();
  return null;
}

/** "¥12,500" や "12500" などから整数の円建てロイヤリティを抽出する。 */
function parseRoyaltyJpy(raw: string): number {
  const digits = raw.replace(/[¥,\s]/g, '');
  const n = parseInt(digits, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** "42" や "7" などから販売冊数を抽出する。 */
function parseUnits(raw: string): number {
  const n = parseInt(raw.replace(/[,\s]/g, ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** "レビュー: 15件" や "15件" や "15" などからレビュー数を抽出する。 */
function parseReviewCount(raw: string): number {
  const m = raw.match(/(\d[\d,]*)/);
  if (!m || !m[1]) return 0;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** "4.3" などから平均星を抽出する。空文字や不正なら null。 */
function parseAvgStars(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = parseFloat(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 5) return null;
  return n;
}

/** Cheerio ロード済み $ から平均星を抽出する。 */
function parseAvgStarsFromPage($: ReturnType<typeof load>): number | null {
  // "4.3 5つ星のうち4.3" パターン
  const altText = $('[class*="a-icon-alt"]').first().text().trim();
  if (altText) {
    const m = altText.match(/^(\d+(?:\.\d+)?)/);
    if (m && m[1]) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n) && n >= 0 && n <= 5) return n;
    }
  }

  // フォールバック: data-hook="average-star-rating"
  const dataHook = $('[data-hook="average-star-rating"] .a-offscreen, [data-hook="average-star-rating"]').first().text().trim();
  if (dataHook) {
    const m = dataHook.match(/(\d+(?:\.\d+)?)/);
    if (m && m[1]) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n) && n >= 0 && n <= 5) return n;
    }
  }

  return null;
}

/** Cheerio ロード済み $ からレビュー数を抽出する。 */
function parseReviewCountFromPage($: ReturnType<typeof load>): number | null {
  // "15個の評価" パターン
  const reviewText = $('#acrCustomerReviewText, [data-hook="total-review-count"]').first().text().trim();
  if (reviewText) {
    const m = reviewText.match(/(\d[\d,]*)/);
    if (m && m[1]) {
      const n = parseInt(m[1].replace(/,/g, ''), 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

/** Cheerio ロード済み $ から BSR（ベストセラーランク）を抽出する。 */
function parseBsrFromPage($: ReturnType<typeof load>): number | null {
  // "#2,345位" や "#2,345 本" パターン
  const salesRankEl = $('#SalesRank').first().text().trim();
  if (salesRankEl) {
    const m = salesRankEl.match(/[\d,]+/);
    if (m && m[0]) {
      const n = parseInt(m[0].replace(/,/g, ''), 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }

  // フォールバック: テキスト検索 "売れ筋ランキング: " の周辺
  let bsr: number | null = null;
  $('*').each((_i, el) => {
    if (bsr !== null) return false; // break
    const text = $(el).text();
    const m = text.match(/売れ筋ランキング.*?#?([\d,]+)\s*位/);
    if (m && m[1]) {
      const n = parseInt(m[1].replace(/,/g, ''), 10);
      if (Number.isFinite(n) && n > 0) {
        bsr = n;
        return false; // break
      }
    }
  });

  return bsr;
}
