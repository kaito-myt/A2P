/**
 * LINE 双方向認証リレー — worker 側送信/待受ヘルパー [sales.fetch 自動再ログイン用]。
 *
 * `apps/web/lib/line-client.ts` / `line-webhook-core.ts` (受信側) と対になる送信側実装。
 * `scripts/kdp-publish.mjs` の `pushLine` / `relayOtpViaLine` と同じパターンを
 * TypeScript worker タスクから使える形で提供する。
 *
 * フロー: `kdp_auth_requests` に pending 行を作成 → LINE push で運営者に通知 →
 * 運営者が LINE アプリに 6 桁コードを返信 → `/api/line/webhook` が同行を fulfilled に
 * 書き戻す → 本モジュールがポーリングして拾い consumed にする。
 *
 * タイムアウト/認証失敗時は再送する (最大 `maxRounds` ラウンド、既定 3)。
 * 各ラウンドは新しい pending 行を作り直す (scripts/kdp-publish.mjs は単発待ちだが、
 * worker 側はサーバー完結を優先するため自動リトライまで面倒を見る)。
 *
 * 仕様根拠: docs/05-program-design.md "LINE 双方向認証リレー" / sales.fetch 自動再ログイン追記。
 */
import { createLogger } from '@a2p/contracts/logger';

const log = createLogger('worker.line-auth-relay');

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

/** Prisma 部分 I/F — テストでモック可能にする (実体は @a2p/db の `prisma.kdpAuthRequest`)。 */
export interface LineAuthRelayPrisma {
  kdpAuthRequest: {
    create(args: {
      data: { purpose: string; status: string; prompt: string; expires_at: Date };
    }): Promise<{ id: string }>;
    findUnique(args: {
      where: { id: string };
    }): Promise<{ id: string; status: string; code: string | null } | null>;
    update(args: {
      where: { id: string };
      data: { status: string; consumed_at?: Date; fulfilled_at?: Date; code?: string | null };
    }): Promise<unknown>;
  };
}

export interface RequestOtpOptions {
  purpose: string;
  prompt: string;
  /** 1 ラウンドあたりの pending 有効期限 (既定 5 分)。 */
  ttlMs?: number;
  /** ポーリング間隔 (既定 2000ms)。 */
  pollMs?: number;
  /** 1 ラウンドあたりの最大待機時間 (既定 = ttlMs)。 */
  maxWaitMs?: number;
  /** タイムアウト時に再送するラウンド数 (既定 3)。 */
  maxRounds?: number;
}

/** LINE 中継が設定済みか (env 未設定なら push はできても意味がない)。 */
export function isLineRelayConfigured(): boolean {
  return Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_ALLOWED_USER_ID);
}

/**
 * LINE Messaging API push でテキストを送る。
 * 失敗しても呼び出し側の処理を止めたくないため、例外は投げず false を返す。
 */
export async function pushLine(text: string): Promise<boolean> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to = process.env.LINE_ALLOWED_USER_ID;
  if (!token || !to) {
    log.warn('LINE relay not configured (LINE_CHANNEL_ACCESS_TOKEN / LINE_ALLOWED_USER_ID) — push skipped');
    return false;
  }
  try {
    const res = await fetch(LINE_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn({ status: res.status, body }, 'LINE push failed');
      return false;
    }
    return true;
  } catch (err) {
    log.warn({ err }, 'LINE push threw');
    return false;
  }
}

/**
 * `kdp_auth_requests` に pending 行を作成し LINE push、返信コードをポーリングして拾う。
 * タイムアウトした場合は行を expired にし、再送通知のうえ新しいラウンドを開始する
 * (最大 `maxRounds` 回)。全ラウンド未受信なら null を返す。
 */
export async function requestOtpViaLine(
  prisma: LineAuthRelayPrisma,
  opts: RequestOtpOptions,
): Promise<string | null> {
  const maxRounds = opts.maxRounds ?? 3;
  const ttlMs = opts.ttlMs ?? 300_000;
  const pollMs = opts.pollMs ?? 2000;
  const maxWaitMs = opts.maxWaitMs ?? ttlMs;

  for (let round = 1; round <= maxRounds; round++) {
    const promptText =
      round === 1 ? opts.prompt : `認証コードを再送してください（${round}/${maxRounds}回目）`;
    const row = await prisma.kdpAuthRequest.create({
      data: {
        purpose: opts.purpose,
        status: 'pending',
        prompt: promptText,
        expires_at: new Date(Date.now() + ttlMs),
      },
    });

    const pushText =
      round === 1
        ? `🔐 A2P: ${opts.prompt}\n認証アプリの6桁コードをこのトークに返信してください（5分以内）。`
        : `🔁 A2P: 認証コードを再送してください（${round}/${maxRounds}回目）。認証アプリに表示中の最新の6桁コードを返信してください（5分以内）。`;
    await pushLine(pushText);

    log.info({ requestId: row.id, round, maxRounds }, 'waiting for OTP via LINE relay');
    const code = await pollForCode(prisma, row.id, pollMs, maxWaitMs);
    if (code) return code;

    log.warn({ requestId: row.id, round, maxRounds }, 'OTP relay round timed out');
    if (round < maxRounds) {
      await pushLine('⏰ A2P: 5分以内に認証コードが届きませんでした。もう一度コードを送っていただければ再開します。');
    }
  }

  await pushLine('🛑 A2P: 認証待ちがタイムアウトしました。');
  return null;
}

/** pending 行を maxWaitMs までポーリングし、fulfilled になったコードを消費して返す。 */
async function pollForCode(
  prisma: LineAuthRelayPrisma,
  requestId: string,
  pollMs: number,
  maxWaitMs: number,
): Promise<string | null> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const row = await prisma.kdpAuthRequest.findUnique({ where: { id: requestId } });
    if (row?.status === 'fulfilled' && row.code) {
      await prisma.kdpAuthRequest.update({
        where: { id: requestId },
        data: { status: 'consumed', consumed_at: new Date() },
      });
      return row.code;
    }
    if (Date.now() >= deadline) {
      if (row?.status === 'pending') {
        await prisma.kdpAuthRequest
          .update({ where: { id: requestId }, data: { status: 'expired' } })
          .catch(() => {});
      }
      return null;
    }
    await sleep(pollMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
