/**
 * LINE 双方向認証リレー — 純粋ロジック (route から DI で切り離してテスト可能にする)。
 *
 * scripts/kdp-publish.mjs がログイン/OTP 待ちで `kdp_auth_requests` に pending 行を作り
 * LINE push で運営者に通知する。運営者が LINE に 6 桁コードを返信すると、この処理が
 * コードを抽出して pending 行に書き戻す (fulfilled)。ローカルツールはポーリングして拾う。
 *
 * 仕様根拠: docs/05-program-design.md "LINE 双方向認証リレー"
 */

/**
 * メッセージ本文から 6 桁の認証コードを抽出する。
 * スペース・ハイフンを除去し、連続数字の「かたまり」を切り出して、その中で
 * ちょうど 6 桁のものを最初に見つかった順に返す (例: "123 456" / "123-456" → "123456")。
 * 5 桁以下・7 桁以上のかたまりはコードとして扱わない。
 */
export function extractOtpCode(text: string): string | null {
  const stripped = text.replace(/[\s-]/g, '');
  const digitRuns = stripped.match(/\d+/g) ?? [];
  return digitRuns.find((run) => run.length === 6) ?? null;
}

export type LineEvent = {
  type: string;
  message?: { type: string; text?: string };
  source?: { userId?: string };
  replyToken?: string;
};

export interface ProcessLineEventsDeps {
  allowedUserId: string;
  now: Date;
  findPending: () => Promise<{ id: string } | null>;
  fulfill: (id: string, code: string) => Promise<void>;
  reply: (replyToken: string, message: string) => Promise<void>;
}

const MSG_ACCEPTED = '✅ 認証コードを受け付けました。ツールが自動で入力します。';
const MSG_NO_PENDING = '現在、認証待ちのリクエストはありません。';
const MSG_NEED_CODE = '6桁の認証コードを送ってください。';

export async function processLineEvents(
  events: LineEvent[],
  deps: ProcessLineEventsDeps,
): Promise<void> {
  for (const event of events) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue;
    if (event.source?.userId !== deps.allowedUserId) continue; // 他ユーザーは黙って無視

    const replyToken = event.replyToken;
    const text = event.message.text ?? '';
    const code = extractOtpCode(text);

    if (!code) {
      if (replyToken) await deps.reply(replyToken, MSG_NEED_CODE);
      continue;
    }

    const pending = await deps.findPending();
    if (!pending) {
      if (replyToken) await deps.reply(replyToken, MSG_NO_PENDING);
      continue;
    }

    await deps.fulfill(pending.id, code);
    if (replyToken) await deps.reply(replyToken, MSG_ACCEPTED);
  }
}
