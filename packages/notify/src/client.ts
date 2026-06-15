import { Resend } from 'resend';

import { ConfigError } from '@a2p/contracts/errors';

/**
 * Resend クライアントシングルトン (docs/03 §D-01, docs/05 §2 packages/notify)
 *
 * `RESEND_API_KEY` は `parseEnv` (packages/contracts/env.ts) が起動時に必須検証する
 * 前提だが、import 順序の都合で notify が先に走るケースもあるため、本モジュールでも
 * 未設定なら ConfigError をその場で投げる。
 *
 * テスト時は `_setResendClientForTests()` でモックを注入し、`_resetResendClientForTests()`
 * で破棄する。
 */

export interface ResendLike {
  emails: {
    send: (...args: Parameters<Resend['emails']['send']>) => ReturnType<Resend['emails']['send']>;
  };
}

let cached: ResendLike | null = null;

export function resolveResendApiKey(source: NodeJS.ProcessEnv = process.env): string {
  const key = source.RESEND_API_KEY;
  if (!key || key.length === 0) {
    throw new ConfigError('Resend API キーが未設定です: RESEND_API_KEY', {
      details: { missing: ['RESEND_API_KEY'] },
    });
  }
  return key;
}

export function createResendClient(apiKey: string): Resend {
  return new Resend(apiKey);
}

export function getResendClient(): ResendLike {
  if (!cached) {
    cached = createResendClient(resolveResendApiKey());
  }
  return cached;
}

export function _setResendClientForTests(client: ResendLike): void {
  cached = client;
}

export function _resetResendClientForTests(): void {
  cached = null;
}
