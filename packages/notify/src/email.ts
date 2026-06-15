import type { ReactElement } from 'react';

import { render } from '@react-email/render';

import { ConfigError, ProviderError } from '@a2p/contracts/errors';
import { createLogger } from '@a2p/contracts/logger';

import { getResendClient, type ResendLike } from './client.js';

const log = createLogger('notify.email');

/**
 * メール送信ラッパ (docs/05 §5.3.9 book-done, §5.3.10 revision-run-completed,
 * docs/03 §D-01)
 *
 * 既定挙動：
 * - `to` 未指定 → env `MAIL_TO`（運営者本人）
 * - `from` 未指定 → env `MAIL_FROM`
 * - `react` を react-email の `render()` で HTML 化。text 版は `render({ plainText: true })`
 * - 失敗は `ProviderError`（provider='resend', retryable=true）にラップ
 *
 * 戻り値の `id` は Resend が払い出すメッセージ ID（後段で `audit_log` 等に保存可）。
 */

export interface SendEmailParams {
  subject: string;
  react: ReactElement;
  /** 既定: env `MAIL_TO`。配列も可。 */
  to?: string | string[];
  /** 既定: env `MAIL_FROM`。 */
  from?: string;
  /** 任意: 明示的に text 版を渡したいとき。未指定なら react から自動生成。 */
  text?: string;
  /** 任意: 返信先。 */
  replyTo?: string;
  /** テスト/DI 用。未指定なら `getResendClient()` を使う。 */
  client?: ResendLike;
}

export interface SendEmailResult {
  id: string;
}

export async function sendEmail(params: SendEmailParams): Promise<SendEmailResult> {
  const from = params.from ?? process.env.MAIL_FROM;
  const to = params.to ?? process.env.MAIL_TO;
  if (!from) {
    throw new ConfigError('メール送信元が未設定です: MAIL_FROM', {
      details: { missing: ['MAIL_FROM'] },
    });
  }
  if (!to) {
    throw new ConfigError('メール送信先が未設定です: MAIL_TO', {
      details: { missing: ['MAIL_TO'] },
    });
  }

  const html = await render(params.react);
  const text = params.text ?? (await render(params.react, { plainText: true }));

  const client = params.client ?? getResendClient();
  const recipients = Array.isArray(to) ? to : [to];

  let response: Awaited<ReturnType<ResendLike['emails']['send']>>;
  try {
    response = await client.emails.send({
      from,
      to: recipients,
      subject: params.subject,
      html,
      text,
      ...(params.replyTo ? { replyTo: params.replyTo } : {}),
    });
  } catch (err) {
    throw new ProviderError('Resend へのメール送信に失敗しました', {
      details: { subject: params.subject, to: recipients },
      cause: err,
    });
  }

  if (response.error) {
    throw new ProviderError('Resend が送信エラーを返しました', {
      details: {
        subject: params.subject,
        to: recipients,
        resendError: { name: response.error.name, message: response.error.message },
      },
    });
  }

  const id = response.data?.id;
  if (!id) {
    throw new ProviderError('Resend のレスポンスに id が含まれていません', {
      details: { subject: params.subject, to: recipients },
    });
  }

  if (process.env.NODE_ENV !== 'test') {
    log.info({ subject: params.subject, to: recipients, id }, 'email.sent');
  }
  return { id };
}
