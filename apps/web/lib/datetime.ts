/**
 * 日時表示ヘルパ。サーバ (Railway=UTC) / クライアントの TZ に依らず **JST 固定**で
 * 整形する。Prisma の Date は UTC 保存なので、そのまま toISOString すると 9 時間ズレる。
 */

const JST_DTF = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** Date | ISO文字列 → "YYYY-MM-DD HH:mm" (JST)。null/不正は "-"。 */
export function formatJstDateTime(input: Date | string | null | undefined): string {
  if (!input) return '-';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '-';
  const p = Object.fromEntries(JST_DTF.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
