/**
 * A2P 通貨ユーティリティ — JPY 整数ヘルパ (docs/05 §12 OQ-D-02 暫定方針)
 *
 * 方針判断: A2P は単一通貨 (JPY) のみを扱い、最小単位 = 1 円 (整数) で完結する。
 * したがって `decimal.js-light` の導入は **保留** し、`number` を厳密に整数として
 * 扱うヘルパに留める。将来 (Phase 2 以降) 多通貨対応または小数 JPY (USD 換算等) が
 * 必要になった時点で再評価する。
 *
 * DB 側は `Decimal(10, 2)` / `Decimal(10, 4)` で `cost_jpy_total` 等を保持するが、
 * 集計時は本ヘルパで `number` (整数 JPY) に切り詰めてから加算する。誤差を抑えるため
 * 個別レコードの加算ではなく、SQL 集計 (`SUM`) 後の 1 回の変換を推奨。
 */

/** 整数 JPY を表すブランド型。`toJpy()` 経由でのみ生成可能。 */
export type JpyAmount = number & { readonly __brand: 'JpyAmount' };

/** Prisma.Decimal 互換の最小形状（`toString()` を持つ任意オブジェクト）。 */
export interface DecimalLike {
  toString(): string;
}

const INTEGER_RE = /^-?\d+$/;

/**
 * 入力を整数 JPY に正規化する。
 * - `number`: 有限値かつ整数のみ受理（小数や NaN/Infinity は throw）
 * - `string`: 半角数字のみ（前後空白は trim）。小数点を含むと throw
 * - 範囲: `Number.MIN_SAFE_INTEGER` ≦ value ≦ `Number.MAX_SAFE_INTEGER`
 */
export function toJpy(value: number | string): JpyAmount {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError(`toJpy: 有限値が必要です (received: ${value})`);
    }
    if (!Number.isInteger(value)) {
      throw new RangeError(`toJpy: JPY は整数のみ受理します (received: ${value})`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`toJpy: 安全な整数範囲を超えています (received: ${value})`);
    }
    return value as JpyAmount;
  }

  const trimmed = value.trim();
  if (!INTEGER_RE.test(trimmed)) {
    throw new RangeError(`toJpy: 整数文字列のみ受理します (received: ${JSON.stringify(value)})`);
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`toJpy: 安全な整数範囲を超えています (received: ${value})`);
  }
  return n as JpyAmount;
}

/** 2 値の加算。両者を `toJpy` で検証してから加算する。 */
export function addJpy(a: number | string, b: number | string): JpyAmount {
  const x = toJpy(a);
  const y = toJpy(b);
  const sum = x + y;
  if (!Number.isSafeInteger(sum)) {
    throw new RangeError(`addJpy: オーバーフローしました (${x} + ${y})`);
  }
  return sum as JpyAmount;
}

/** 配列を集約。空配列は 0 を返す。 */
export function sumJpy(values: ReadonlyArray<number | string>): JpyAmount {
  let acc = 0;
  for (const v of values) {
    acc += toJpy(v);
    if (!Number.isSafeInteger(acc)) {
      throw new RangeError(`sumJpy: オーバーフローしました (partial: ${acc})`);
    }
  }
  return acc as JpyAmount;
}

/**
 * 表示用フォーマット。`¥1,234,567` 形式。
 * - 入力は `toJpy` で検証
 * - ロケール非依存（手書きの 3 桁区切り）。SSR / Worker 双方で同一結果。
 */
export function formatJpy(value: number | string): string {
  const n = toJpy(value);
  const negative = n < 0;
  const abs = Math.abs(n).toString();
  const grouped = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}¥${grouped}`;
}

/**
 * Prisma `Decimal` 形状から整数 JPY に変換する。
 * - DB 列は `Decimal(10, 2)` 等で保持されるが、JPY 集計では小数部を切り捨てる
 *   ことで誤差を抑える（OQ-D-02 暫定）
 * - `Math.trunc` 相当（負値も 0 方向に丸め）
 */
export function decimalToJpy(value: DecimalLike): JpyAmount {
  const s = value.toString().trim();
  if (s === '' || s.toLowerCase() === 'nan') {
    throw new RangeError(`decimalToJpy: 不正な Decimal です (received: ${JSON.stringify(s)})`);
  }
  // 指数表記や符号、整数部のみを許容する素朴パーサ（小数点以下は切り捨て）
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) {
    throw new RangeError(`decimalToJpy: Decimal 形式を解釈できません (received: ${JSON.stringify(s)})`);
  }
  const sign = m[1] === '-' ? -1 : 1;
  const intPart = m[2] ?? '0';
  const n = sign * Number(intPart);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`decimalToJpy: 安全な整数範囲を超えています (received: ${s})`);
  }
  return n as JpyAmount;
}

/**
 * 整数 JPY を Prisma `Decimal` に渡せる文字列に変換する。
 * Prisma の `Decimal` カラムは文字列受け入れ可能であり、`number` を直接渡すと
 * `Decimal.js` が浮動小数経由で精度を失う恐れがあるため、文字列での受け渡しを推奨。
 */
export function jpyToDecimalString(value: number | string): string {
  return toJpy(value).toString();
}
