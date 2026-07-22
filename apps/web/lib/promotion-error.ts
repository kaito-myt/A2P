/**
 * 販促投稿の失敗理由 (`promotion_posts.error`) を、人間が読める日本語 + 対処手順に翻訳する。
 *
 * worker は失敗時に `${reason}: ${message}` 形式で error を保存する
 * (apps/worker/src/tasks/promotion-post-publish.ts)。例:
 *   - `auth: X API responded 403: {"detail":"You are not permitted to perform this action.",...}`
 *   - `not_connected: channel instagram needs a webhook_url or token to publish`
 *   - `rate_limit: X API responded 429: ...`
 *
 * この生文字列は運営者には解読困難なため、既知のシグネチャを分類して
 * 「何が起きたか」「どう直すか」を提示する。未知パターンは generic + 生文字列を残す。
 */
import { messages } from './messages';

const pe = messages.promotionChannels.postError;

export interface PromotionErrorExplanation {
  /** 見出し (何が起きたか)。 */
  title: string;
  /** 対処手順 (どう直すか)。 */
  hint: string;
  /** デバッグ用の生エラー文字列 (折りたたみ表示用)。 */
  raw: string;
}

/**
 * 失敗理由文字列 → 説明。null/空なら null (失敗表示なし)。
 */
export function explainPromotionError(
  raw: string | null | undefined,
): PromotionErrorExplanation | null {
  if (!raw || raw.trim().length === 0) return null;
  const s = raw.toLowerCase();

  const wrap = (m: { title: string; hint: string }): PromotionErrorExplanation => ({
    title: m.title,
    hint: m.hint,
    raw,
  });

  // --- X (Twitter) API 固有 ---------------------------------------------
  const isX = s.includes('x api') || s.includes('twitter');
  const has403 = s.includes('403') || s.includes('forbidden');
  const hasNotPermitted = s.includes('not permitted to perform this action');

  // 403「権限がありません」= アプリが Read-only。最頻出かつ最重要。
  if (hasNotPermitted || (isX && has403)) {
    // 402 相当 (課金/枠) が混じるケースを軽く分離
    if (s.includes('402') || s.includes('payment') || s.includes('usage cap') || s.includes('quota')) {
      return wrap(pe.xPayment);
    }
    return wrap(pe.xForbidden);
  }
  if (s.includes('402') || s.includes('payment required')) {
    return wrap(pe.xPayment);
  }
  if (isX && (s.includes('401') || s.includes('unauthorized'))) {
    return wrap(pe.xUnauthorized);
  }

  // --- レート上限 --------------------------------------------------------
  if (s.startsWith('rate_limit') || s.includes('429') || s.includes('too many requests')) {
    return wrap(pe.rateLimit);
  }

  // --- 未連携 / 接続情報なし --------------------------------------------
  if (
    s.startsWith('not_connected') ||
    s.includes('not configured') ||
    s.includes('needs a webhook_url or token') ||
    s.includes('credentials not configured') ||
    s.includes('token not configured')
  ) {
    return wrap(pe.notConnected);
  }
  if (s.startsWith('account_not_connected') || s.includes('routed account not connected')) {
    return wrap(pe.accountNotConnected);
  }

  // --- 中継 (Webhook) 側エラー ------------------------------------------
  if (s.includes('webhook responded')) {
    return wrap(pe.webhookRelay);
  }

  // --- 本文不正 ----------------------------------------------------------
  if (s.startsWith('invalid') || s.includes('empty tweet') || s.includes('empty ')) {
    return wrap(pe.invalidBody);
  }

  // --- 認証系 (X 以外も含む汎用) ----------------------------------------
  if (s.startsWith('auth') || s.includes('401') || s.includes('unauthorized')) {
    return wrap(pe.xUnauthorized);
  }

  return wrap(pe.generic);
}
