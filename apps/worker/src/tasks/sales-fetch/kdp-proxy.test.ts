import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { buildProxyConfig, resolveKdpProxy, PROXY_FRESH_MS, type KdpProxyPrisma } from './kdp-proxy.js';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const fresh = new Date(NOW.getTime() - 60_000); // 1分前
const stale = new Date(NOW.getTime() - PROXY_FRESH_MS - 1000); // 失効

describe('buildProxyConfig', () => {
  it('url が無ければ null', () => {
    expect(buildProxyConfig({ url: null, updatedAt: fresh }, NOW)).toBeNull();
    expect(buildProxyConfig({ url: '  ', updatedAt: fresh }, NOW)).toBeNull();
  });

  it('heartbeat が古ければ null (直結フォールバック)', () => {
    expect(buildProxyConfig({ url: '1.tcp.ngrok.io:12345', updatedAt: stale }, NOW)).toBeNull();
    expect(buildProxyConfig({ url: '1.tcp.ngrok.io:12345', updatedAt: null }, NOW)).toBeNull();
  });

  it('新鮮なら http:// を付けた server と env 認証を返す', () => {
    const cfg = buildProxyConfig(
      { url: '1.tcp.ngrok.io:12345', updatedAt: fresh, user: 'u', pass: 'p' },
      NOW,
    );
    expect(cfg).toEqual({ server: 'http://1.tcp.ngrok.io:12345', username: 'u', password: 'p' });
  });

  it('保存値にスキームが混じっても host:port に正規化する', () => {
    const cfg = buildProxyConfig({ url: 'tcp://1.tcp.ngrok.io:12345/', updatedAt: fresh }, NOW);
    expect(cfg?.server).toBe('http://1.tcp.ngrok.io:12345');
  });

  it('認証情報が無ければ username/password は省略', () => {
    const cfg = buildProxyConfig({ url: 'host:1', updatedAt: fresh }, NOW);
    expect(cfg).toEqual({ server: 'http://host:1' });
  });
});

describe('resolveKdpProxy', () => {
  const OLD = { ...process.env };
  beforeEach(() => {
    process.env.KDP_PROXY_USER = 'envuser';
    process.env.KDP_PROXY_PASS = 'envpass';
  });
  afterEach(() => {
    process.env = { ...OLD };
  });

  function db(row: unknown): KdpProxyPrisma {
    return { appSettings: { findUnique: vi.fn().mockResolvedValue(row) } } as unknown as KdpProxyPrisma;
  }

  it('kdp_proxy_enabled=false なら null', async () => {
    const cfg = await resolveKdpProxy(
      db({ kdp_proxy_enabled: false, kdp_proxy_url: '1.tcp.ngrok.io:1', kdp_proxy_updated_at: fresh }),
      () => NOW,
    );
    expect(cfg).toBeNull();
  });

  it('有効かつ新鮮なら env 認証付き config', async () => {
    const cfg = await resolveKdpProxy(
      db({ kdp_proxy_enabled: true, kdp_proxy_url: '1.tcp.ngrok.io:12345', kdp_proxy_updated_at: fresh }),
      () => NOW,
    );
    expect(cfg).toEqual({
      server: 'http://1.tcp.ngrok.io:12345',
      username: 'envuser',
      password: 'envpass',
    });
  });

  it('有効でも heartbeat が古ければ null', async () => {
    const cfg = await resolveKdpProxy(
      db({ kdp_proxy_enabled: true, kdp_proxy_url: '1.tcp.ngrok.io:12345', kdp_proxy_updated_at: stale }),
      () => NOW,
    );
    expect(cfg).toBeNull();
  });

  it('行が無ければ null', async () => {
    const cfg = await resolveKdpProxy(db(null), () => NOW);
    expect(cfg).toBeNull();
  });

  it('DB 例外時は null (直結フォールバック)', async () => {
    const broken = {
      appSettings: { findUnique: vi.fn().mockRejectedValue(new Error('db down')) },
    } as unknown as KdpProxyPrisma;
    expect(await resolveKdpProxy(broken, () => NOW)).toBeNull();
  });
});
