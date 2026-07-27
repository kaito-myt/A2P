/**
 * LINE Messaging API の薄いクライアント (Node ランタイム専用, node:crypto + fetch)。
 *
 * 仕様根拠: docs/05-program-design.md "LINE 双方向認証リレー"
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * `x-line-signature` ヘッダを channel secret で検証する。
 * HMAC-SHA256(channelSecret, rawBody) の base64 をタイミングセーフに比較する。
 */
export function verifyLineSignature(
  channelSecret: string,
  rawBody: string,
  signature: string | null,
): boolean {
  if (!signature) return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest('base64');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * LINE Reply API でテキストメッセージを返信する。
 * 失敗しても webhook 処理自体は継続させたいため、例外は投げずログのみ出す。
 */
export async function replyLine(
  accessToken: string,
  replyToken: string,
  text: string,
): Promise<void> {
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[line-client] reply failed: ${res.status} ${body}`);
    }
  } catch (err) {
    console.error('[line-client] reply threw', err);
  }
}
