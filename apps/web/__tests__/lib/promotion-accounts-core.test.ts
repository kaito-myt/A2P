import { describe, expect, it, vi } from 'vitest';

import {
  connectPromotionAccountCore,
  archivePromotionAccountCore,
  type AccountRow,
  type PromotionAccountsDeps,
} from '@/lib/promotion-accounts-core';

function makeDeps(existing: AccountRow | null) {
  const update = vi.fn(async (_args: { where: { id: string }; data: Record<string, unknown> }) => ({}));
  const auditCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({}));
  const deps: PromotionAccountsDeps = {
    accountRepo: {
      findUnique: vi.fn(async () => existing),
      update,
    },
    auditLogRepo: { create: auditCreate },
    session: { user: { id: 'u1' } },
    encrypt: (p) => `enc(${p})`,
    mask: (p) => `${p.slice(0, 2)}***`,
  };
  return { deps, update, auditCreate };
}

const pendingX: AccountRow = {
  id: 'a1',
  channel: 'x',
  niche: '朝活',
  status: 'pending',
  handle: null,
  token_enc: null,
  token_mask: null,
  config_json: null,
};

describe('connectPromotionAccountCore', () => {
  it('トークンを暗号化保存し connected へ昇格する', async () => {
    const { deps, update } = makeDeps(pendingX);
    const res = await connectPromotionAccountCore({ account_id: 'a1', handle: '@asakatsu', token: 'tok123' }, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.connected).toBe(true);
    const data = update.mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.status).toBe('connected');
    expect(data.handle).toBe('@asakatsu');
    expect(data.token_enc).toBe('enc(tok123)');
    expect(data.token_mask).toBe('to***');
  });

  it('トークン未入力なら connected に昇格しない（非所有チャンネル）', async () => {
    const { deps, update } = makeDeps(pendingX);
    const res = await connectPromotionAccountCore({ account_id: 'a1', handle: '@x' }, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.connected).toBe(false);
    expect((update.mock.calls[0]![0].data as Record<string, unknown>).status).toBe('pending');
  });

  it('blog は所有チャンネルなのでトークン無しでも connected', async () => {
    const { deps } = makeDeps({ ...pendingX, channel: 'blog' });
    const res = await connectPromotionAccountCore({ account_id: 'a1', handle: 'myblog' }, deps);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.connected).toBe(true);
  });

  it('存在しないアカウントは not_found', async () => {
    const { deps } = makeDeps(null);
    const res = await connectPromotionAccountCore({ account_id: 'x', token: 't' }, deps);
    expect(res.ok).toBe(false);
  });

  it('監査ログにトークン平文を残さない', async () => {
    const { deps, auditCreate } = makeDeps(pendingX);
    await connectPromotionAccountCore({ account_id: 'a1', token: 'secret-token' }, deps);
    const logged = JSON.stringify(auditCreate.mock.calls[0]![0]);
    expect(logged).not.toContain('secret-token');
  });
});

describe('archivePromotionAccountCore', () => {
  it('status を archived にする', async () => {
    const { deps, update } = makeDeps(pendingX);
    const res = await archivePromotionAccountCore({ account_id: 'a1' }, deps);
    expect(res.ok).toBe(true);
    expect((update.mock.calls[0]![0].data as Record<string, unknown>).status).toBe('archived');
  });
});
