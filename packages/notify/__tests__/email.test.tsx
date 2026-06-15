import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigError, ProviderError } from '@a2p/contracts/errors';

import { _resetResendClientForTests, _setResendClientForTests, type ResendLike } from '../src/client.js';
import { sendEmail } from '../src/email.js';
import { buildPricingChangedEmail } from '../src/templates/pricing-changed.js';

type SendArg = Parameters<ResendLike['emails']['send']>[0];

function makeMockClient(impl: (arg: SendArg) => unknown): { client: ResendLike; calls: SendArg[] } {
  const calls: SendArg[] = [];
  const client: ResendLike = {
    emails: {
      send: (async (arg: SendArg) => {
        calls.push(arg);
        const result = impl(arg);
        return result as never;
      }) as ResendLike['emails']['send'],
    },
  };
  return { client, calls };
}

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  process.env.MAIL_FROM = 'noreply@a2p.test';
  process.env.MAIL_TO = 'operator@a2p.test';
  process.env.NEXT_PUBLIC_APP_URL = 'https://a2p.test';
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIG_ENV);
  _resetResendClientForTests();
  vi.restoreAllMocks();
});

describe('sendEmail', () => {
  it('Resend に from/to/subject/html/text を渡す', async () => {
    const { client, calls } = makeMockClient(() => ({
      data: { id: 'msg_123' },
      error: null,
    }));
    _setResendClientForTests(client);

    const { subject, react } = buildPricingChangedEmail({
      model: 'claude-opus-4-7',
      oldUsdPerMtok: 15,
      newUsdPerMtok: 18,
      deltaPct: 20,
    });

    const result = await sendEmail({ subject, react });
    expect(result.id).toBe('msg_123');
    expect(calls).toHaveLength(1);
    const arg = calls[0]!;
    expect(arg.from).toBe('noreply@a2p.test');
    expect(arg.to).toEqual(['operator@a2p.test']);
    expect(arg.subject).toBe(subject);
    expect(typeof arg.html).toBe('string');
    expect(arg.html).toContain('モデル単価が変動しました');
    expect(typeof arg.text).toBe('string');
    expect(arg.text).toContain('claude-opus-4-7');
  });

  it('to を明示すれば env を上書きする', async () => {
    const { client, calls } = makeMockClient(() => ({ data: { id: 'm1' }, error: null }));
    _setResendClientForTests(client);

    const { subject, react } = buildPricingChangedEmail({
      model: 'gpt-image-1',
      oldUsdPerMtok: 1,
      newUsdPerMtok: 2,
      deltaPct: 100,
    });
    await sendEmail({ subject, react, to: ['ops@example.com', 'cc@example.com'] });
    expect(calls[0]!.to).toEqual(['ops@example.com', 'cc@example.com']);
  });

  it('MAIL_FROM 未設定なら ConfigError を投げる', async () => {
    delete process.env.MAIL_FROM;
    const { client } = makeMockClient(() => ({ data: { id: 'x' }, error: null }));
    _setResendClientForTests(client);

    const { subject, react } = buildPricingChangedEmail({
      model: 'm',
      oldUsdPerMtok: 1,
      newUsdPerMtok: 1,
      deltaPct: 0,
    });
    await expect(sendEmail({ subject, react })).rejects.toBeInstanceOf(ConfigError);
  });

  it('Resend が error を返したら ProviderError にラップする', async () => {
    const { client } = makeMockClient(() => ({
      data: null,
      error: { name: 'invalid_api_key', message: 'API key invalid' },
    }));
    _setResendClientForTests(client);

    const { subject, react } = buildPricingChangedEmail({
      model: 'm',
      oldUsdPerMtok: 1,
      newUsdPerMtok: 1,
      deltaPct: 0,
    });
    const err = await sendEmail({ subject, react }).catch((e) => e as unknown);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('provider');
    expect((err as ProviderError).retryable).toBe(true);
  });

  it('Resend が throw したら ProviderError にラップする', async () => {
    const { client } = makeMockClient(() => {
      throw new Error('network down');
    });
    _setResendClientForTests(client);

    const { subject, react } = buildPricingChangedEmail({
      model: 'm',
      oldUsdPerMtok: 1,
      newUsdPerMtok: 1,
      deltaPct: 0,
    });
    const err = await sendEmail({ subject, react }).catch((e) => e as unknown);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toContain('Resend');
  });
});
