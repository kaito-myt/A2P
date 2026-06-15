/**
 * cron-utils.ts — cron 式 → 人間可読 JST ラベル変換 (T-12-08).
 *
 * 純関数のみ。外部依存なし。ブラウザ/Node 両環境で動作する。
 *
 * 仕様: 5 フィールド (分 時 日 月 曜) の cron 式を受け取り
 * 「毎日 02:00 JST」などの人間可読ラベルを返す。
 * 無効な式は INVALID_CRON フォールバックを返す。
 */

const JST_OFFSET_H = 9; // JST = UTC+9

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 5 フィールド cron 式 (分 時 日 月 曜) を人間可読 JST ラベルに変換する。
 *
 * 例:
 *   '0 17 * * *'  → '毎日 02:00 JST'
 *   '30 8 * * 1'  → '毎週月曜 17:30 JST'
 *   '0 0 1 * *'   → '毎月 1 日 09:00 JST'
 *   '* * *'       → '(無効な cron 式)'
 *
 * @throws never — 無効な式の場合はフォールバック文字列を返す
 */
export function nextCronRunJst(cronExpression: string): string {
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return '(無効な cron 式)';
  }

  // length === 5 is guaranteed above, so these are always defined
  const minuteF = fields[0] as string;
  const hourF = fields[1] as string;
  const dayF = fields[2] as string;
  const monthF = fields[3] as string;
  const weekdayF = fields[4] as string;

  // Validate each field is either '*', a single integer, or a simple */n expression
  if (!isValidField(minuteF) || !isValidField(hourF) || !isValidField(dayF) || !isValidField(monthF) || !isValidField(weekdayF)) {
    return '(無効な cron 式)';
  }

  // Validate ranges
  const minuteV = parseIntOrStar(minuteF);
  const hourV = parseIntOrStar(hourF);
  if (minuteV !== null && (minuteV < 0 || minuteV > 59)) return '(無効な cron 式)';
  if (hourV !== null && (hourV < 0 || hourV > 23)) return '(無効な cron 式)';

  // Time label in JST
  const timeLabel = buildTimeLabel(minuteV, hourV, hourF, minuteF);

  // Schedule description
  if (isWildcard(dayF) && isWildcard(monthF) && isWildcard(weekdayF)) {
    return `毎日 ${timeLabel} JST`;
  }

  if (isWildcard(dayF) && isWildcard(monthF) && !isWildcard(weekdayF)) {
    const weekdayNum = parseIntOrStar(weekdayF);
    const weekdayLabel = weekdayNum !== null ? WEEKDAY_LABELS[weekdayNum] ?? `曜日${weekdayNum}` : '毎曜日';
    return `毎週${weekdayLabel} ${timeLabel} JST`;
  }

  if (!isWildcard(dayF) && isWildcard(monthF) && isWildcard(weekdayF)) {
    const dayNum = parseIntOrStar(dayF);
    const dayLabel = dayNum !== null ? `${dayNum} 日` : '毎日';
    return `毎月 ${dayLabel} ${timeLabel} JST`;
  }

  // Fallback: return a generic description with UTC→JST time
  return `定期実行 ${timeLabel} JST`;
}

/**
 * cron 式が有効な 5 フィールド式かどうかを検証する。
 * true = 有効, false = 無効
 */
export function isValidCronExpression(cronExpression: string): boolean {
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const minuteF = fields[0] as string;
  const hourF = fields[1] as string;
  const dayF = fields[2] as string;
  const monthF = fields[3] as string;
  const weekdayF = fields[4] as string;
  if (!isValidField(minuteF) || !isValidField(hourF) || !isValidField(dayF) || !isValidField(monthF) || !isValidField(weekdayF)) {
    return false;
  }
  const minuteV = parseIntOrStar(minuteF);
  const hourV = parseIntOrStar(hourF);
  const dayV = parseIntOrStar(dayF);
  const monthV = parseIntOrStar(monthF);
  const weekdayV = parseIntOrStar(weekdayF);
  if (minuteV !== null && (minuteV < 0 || minuteV > 59)) return false;
  if (hourV !== null && (hourV < 0 || hourV > 23)) return false;
  if (dayV !== null && (dayV < 1 || dayV > 31)) return false;
  if (monthV !== null && (monthV < 1 || monthV > 12)) return false;
  if (weekdayV !== null && (weekdayV < 0 || weekdayV > 7)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const WEEKDAY_LABELS: Record<number, string> = {
  0: '日曜',
  1: '月曜',
  2: '火曜',
  3: '水曜',
  4: '木曜',
  5: '金曜',
  6: '土曜',
  7: '日曜', // 7 is also Sunday in some cron implementations
};

/** Returns null for '*', integer value for numeric fields */
function parseIntOrStar(field: string): number | null {
  if (isWildcard(field)) return null;
  const n = parseInt(field, 10);
  return Number.isFinite(n) ? n : null;
}

function isWildcard(field: string): boolean {
  return field === '*';
}

/**
 * Accepts: '*', single integer, or simple step '* /n' (no space in actual cron)
 */
function isValidField(field: string): boolean {
  if (field === '*') return true;
  if (/^\d+$/.test(field)) return true;
  // Allow */n patterns
  if (/^\*\/\d+$/.test(field)) return true;
  // Allow ranges like 1-5
  if (/^\d+-\d+$/.test(field)) return true;
  return false;
}

function buildTimeLabel(
  minuteV: number | null,
  hourV: number | null,
  hourF: string,
  minuteF: string,
): string {
  if (minuteV === null || hourV === null) {
    // Can't produce a simple time label
    const hPart = isWildcard(hourF) ? '毎時' : `${hourV}`;
    const mPart = isWildcard(minuteF) ? '毎分' : `${minuteV}分`;
    return `${hPart} ${mPart}`;
  }
  // Convert UTC → JST
  const totalMinutes = hourV * 60 + minuteV + JST_OFFSET_H * 60;
  const jstHour = Math.floor(totalMinutes / 60) % 24;
  const jstMin = totalMinutes % 60;
  return `${String(jstHour).padStart(2, '0')}:${String(jstMin).padStart(2, '0')}`;
}
