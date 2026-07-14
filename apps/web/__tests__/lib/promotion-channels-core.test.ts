/**
 * F-052 — promotion-channels-core の単体テスト。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  cancelPostCore,
  publishPostNowCore,
  setChannelAutoCore,
  setChannelConnectionCore,
  testChannelConnectionCore,
  type PromotionChannelsDeps,
} from '../../lib/promotion-channels-core';

function makeDeps(overrides: Partial<PromotionChannelsDeps> = {}): {
  deps: PromotionChannelsDeps;
  upsert: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
} {
  const upsert = vi.fn(async () => ({}));
  const enqueue = vi.fn(async () => {});
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const audit = vi.fn(async () => ({}));
  const deps: PromotionChannelsDeps = {
    channelSettingRepo: {
      findUnique: vi.fn(async () => null),
      upsert,
    },
    postRepo: {
      findUnique: vi.fn(async () => ({ id: 'p1', status: 'scheduled', channel: 'x' })),
      updateMany,
    },
    auditLogRepo: { create: audit },
    session: { user: { id: 'u1' } },
    enqueue,
    encrypt: (p) => `ENC(${p})`,
    mask: (p) => `mask-${p.slice(-2)}`,
    ...overrides,
  };
  return { deps, upsert, enqueue, updateMany, audit };
}

describe('setChannelAutoCore', () => {
  it('upserts auto_enabled and writes audit', async () => {
    const { deps, upsert, audit } = makeDeps();
    const res = await setChannelAutoCore({ channel: 'x', auto_enabled: true }, deps);
    expect(res.ok).toBe(true);
    expect(upsert).toHaveBeenCalledWith({
      where: { channel: 'x' },
      create: { channel: 'x', auto_enabled: true },
      update: { auto_enabled: true },
    });
    expect(audit).toHaveBeenCalled();
  });

  it('rejects invalid channel', async () => {
    const { deps } = makeDeps();
    const res = await setChannelAutoCore({ channel: 'facebook', auto_enabled: true }, deps);
    expect(res.ok).toBe(false);
  });
});

describe('setChannelConnectionCore', () => {
  it('encrypts a new token and stores webhook in config_json', async () => {
    const { deps, upsert } = makeDeps();
    const res = await setChannelConnectionCore(
      { channel: 'note', handle: '@me', webhook_url: 'https://hook.test/x', token: 'secret' },
      deps,
    );
    expect(res.ok).toBe(true);
    const call = upsert.mock.calls[0]![0];
    expect(call.update.token_enc).toBe('ENC(secret)');
    expect(call.update.token_mask).toBe('mask-et');
    expect((call.update.config_json as { webhook_url: string }).webhook_url).toBe('https://hook.test/x');
    if (res.ok) expect(res.data.connected).toBe(true);
  });

  it('does not overwrite token when token omitted', async () => {
    const { deps, upsert } = makeDeps({
      channelSettingRepo: {
        findUnique: vi.fn(async () => ({
          channel: 'x',
          auto_enabled: true,
          handle: '@x',
          token_enc: 'EXISTING',
          token_mask: 'mask-xx',
          config_json: {},
        })),
        upsert: vi.fn(async () => ({})),
      },
    });
    // re-grab upsert from the overridden repo
    const overriddenUpsert = deps.channelSettingRepo.upsert as ReturnType<typeof vi.fn>;
    const res = await setChannelConnectionCore({ channel: 'x', handle: '@x' }, deps);
    expect(res.ok).toBe(true);
    const call = overriddenUpsert.mock.calls[0]![0];
    expect(call.update.token_enc).toBeUndefined();
    // already connected via existing token
    if (res.ok) expect(res.data.connected).toBe(true);
    expect(upsert).not.toBe(overriddenUpsert);
  });
});

describe('testChannelConnectionCore', () => {
  it('decrypts stored token, passes it + webhook to probe, records audit', async () => {
    const probe = vi.fn(async () => ({ ok: true, method: 'x_api' as const, message: 'OK ✓', identity: '@me' }));
    const { deps, audit } = makeDeps({
      channelSettingRepo: {
        findUnique: vi.fn(async () => ({
          channel: 'x',
          auto_enabled: true,
          handle: '@me',
          token_enc: 'ENC-TOKEN',
          token_mask: 'mask',
          config_json: { webhook_url: 'https://hook.test/relay' },
        })),
        upsert: vi.fn(async () => ({})),
      },
      decrypt: (enc) => `plain(${enc})`,
      probe,
    });
    const res = await testChannelConnectionCore({ channel: 'x' }, deps);
    expect(res.ok).toBe(true);
    expect(probe).toHaveBeenCalledWith({
      channel: 'x',
      token: 'plain(ENC-TOKEN)',
      webhookUrl: 'https://hook.test/relay',
    });
    if (res.ok) expect(res.data.identity).toBe('@me');
    // audit は認証可否と手段のみ (token は残さない)。
    const auditArg = audit.mock.calls[0]![0] as { data: { after_json: Record<string, unknown> } };
    expect(auditArg.data.after_json).toMatchObject({ ok: true, method: 'x_api' });
    expect(JSON.stringify(auditArg)).not.toContain('plain(ENC-TOKEN)');
  });

  it('passes token=null when no token stored', async () => {
    const probe = vi.fn(async () => ({ ok: false, method: 'none' as const, message: 'no' }));
    const { deps } = makeDeps({
      channelSettingRepo: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
      decrypt: (enc) => `plain(${enc})`,
      probe,
    });
    const res = await testChannelConnectionCore({ channel: 'note' }, deps);
    expect(res.ok).toBe(true);
    expect(probe).toHaveBeenCalledWith({ channel: 'note', token: null, webhookUrl: null });
  });

  it('rejects invalid channel', async () => {
    const { deps } = makeDeps({ probe: vi.fn() });
    const res = await testChannelConnectionCore({ channel: 'facebook' }, deps);
    expect(res.ok).toBe(false);
  });
});

describe('publishPostNowCore', () => {
  it('resets post to scheduled and enqueues force publish', async () => {
    const { deps, enqueue, updateMany } = makeDeps();
    const res = await publishPostNowCore({ post_id: 'p1' }, deps);
    expect(res.ok).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', status: { in: ['scheduled', 'draft', 'failed'] } },
      data: { status: 'scheduled', error: null },
    });
    expect(enqueue).toHaveBeenCalledWith('promotion.post.publish', { post_id: 'p1', force: true });
  });

  it('returns not_found when post missing', async () => {
    const { deps } = makeDeps({
      postRepo: { findUnique: vi.fn(async () => null), updateMany: vi.fn(async () => ({ count: 0 })) },
    });
    const res = await publishPostNowCore({ post_id: 'x' }, deps);
    expect(res.ok).toBe(false);
  });
});

describe('cancelPostCore', () => {
  it('cancels a scheduled post', async () => {
    const { deps, updateMany } = makeDeps();
    const res = await cancelPostCore({ post_id: 'p1' }, deps);
    expect(res.ok).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', status: { in: ['scheduled', 'draft', 'failed'] } },
      data: { status: 'canceled' },
    });
  });

  it('conflict when nothing updated', async () => {
    const { deps } = makeDeps({
      postRepo: {
        findUnique: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    });
    const res = await cancelPostCore({ post_id: 'p1' }, deps);
    expect(res.ok).toBe(false);
  });
});
