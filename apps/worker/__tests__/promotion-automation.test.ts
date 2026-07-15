/**
 * F-052 — 販促自動運用 worker タスクの単体テスト。
 *   - promotion.posts.generate: プラン → 投稿キュー生成 (冪等)
 *   - promotion.post.publish:   1 投稿の実投稿 (ガード・状態遷移・復号)
 *   - promotion.dispatch:       期限到来分を publish に流す (フィルタ条件)
 */
import { describe, expect, it, vi } from 'vitest';

import { runPromotionPostsGenerate } from '../src/tasks/promotion-posts-generate.js';
import { runPromotionPostPublish } from '../src/tasks/promotion-post-publish.js';
import { runPromotionDispatch } from '../src/tasks/promotion-dispatch.js';
import {
  createStubPublisherPort,
  createNotConnectedPublisherPort,
  type PublisherPort,
} from '../src/tasks/promotion-post/publisher-port.js';

const PLAN = {
  summary: '販促方針',
  promo_copy: {
    x_posts: ['告知A', '告知B'],
    note_article: '# note見出し\n本文',
    blog_outline: 'ブログ骨子',
  },
};

// ---------------------------------------------------------------------------
// promotion.posts.generate
// ---------------------------------------------------------------------------

describe('runPromotionPostsGenerate', () => {
  it('プランから X/IG/TikTok×2 / note×1 / blog×1 の投稿を日程付きで作る', async () => {
    const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      promotionPlan: { findUnique: vi.fn(async () => ({ plan_json: PLAN })) },
      book: { findUnique: vi.fn(async () => ({ asin: null, theme: { genre: 'practical' } })) },
      promotionAccount: { findMany: vi.fn(async () => []) },
      promotionPost: { deleteMany, createMany },
    };
    const now = () => new Date('2026-07-08T00:00:00Z');

    const res = await runPromotionPostsGenerate({ book_id: 'b1' }, { prisma, now });

    // x_posts 2件 × 3プラットフォーム + note + blog = 8
    expect(res.created).toBe(8);
    const rows = createMany.mock.calls[0]![0].data as Array<{
      channel: string;
      scheduled_for: Date;
      title: string | null;
    }>;
    expect(rows.filter((r) => r.channel === 'x')).toHaveLength(2);
    expect(rows.filter((r) => r.channel === 'instagram')).toHaveLength(2);
    expect(rows.filter((r) => r.channel === 'tiktok')).toHaveLength(2);
    expect(rows.filter((r) => r.channel === 'note')).toHaveLength(1);
    expect(rows.filter((r) => r.channel === 'blog')).toHaveLength(1);
    // x#0 at base, x#1 at +1day
    const x = rows.filter((r) => r.channel === 'x').sort((a, b) => +a.scheduled_for - +b.scheduled_for);
    expect(x[0]!.scheduled_for.toISOString()).toBe('2026-07-08T00:00:00.000Z');
    expect(x[1]!.scheduled_for.toISOString()).toBe('2026-07-09T00:00:00.000Z');
    const note = rows.find((r) => r.channel === 'note');
    expect(note!.title).toBe('note見出し');
  });

  it('未投稿の既存分を削除してから作り直す (冪等)', async () => {
    const deleteMany = vi.fn(async () => ({ count: 3 }));
    const prisma = {
      promotionPlan: { findUnique: vi.fn(async () => ({ plan_json: PLAN })) },
      book: { findUnique: vi.fn(async () => ({ asin: null, theme: { genre: 'practical' } })) },
      promotionAccount: { findMany: vi.fn(async () => []) },
      promotionPost: { deleteMany, createMany: vi.fn(async (a: { data: unknown[] }) => ({ count: a.data.length })) },
    };
    const res = await runPromotionPostsGenerate({ book_id: 'b1' }, { prisma });
    expect(deleteMany).toHaveBeenCalledWith({ where: { book_id: 'b1', status: { in: ['scheduled', 'draft'] } } });
    expect(res.removed).toBe(3);
  });

  it('プランが無ければ何もしない', async () => {
    const prisma = {
      promotionPlan: { findUnique: vi.fn(async () => null) },
      book: { findUnique: vi.fn(async () => ({ asin: null, theme: { genre: 'practical' } })) },
      promotionAccount: { findMany: vi.fn(async () => []) },
      promotionPost: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const res = await runPromotionPostsGenerate({ book_id: 'b1' }, { prisma });
    expect(res).toEqual({ created: 0, removed: 0 });
    expect(prisma.promotionPost.deleteMany).not.toHaveBeenCalled();
  });

  it('P4: 接続済み台帳アカウントがあれば account_id を振り分ける', async () => {
    const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
    const prisma = {
      promotionPlan: { findUnique: vi.fn(async () => ({ plan_json: PLAN })) },
      book: { findUnique: vi.fn(async () => ({ asin: null, theme: { genre: 'practical' } })) },
      promotionAccount: {
        findMany: vi.fn(async () => [{ id: 'x-acct', channel: 'x', niche: 'practical 実用' }]),
      },
      promotionPost: { deleteMany: vi.fn(async () => ({ count: 0 })), createMany },
    };
    await runPromotionPostsGenerate({ book_id: 'b1' }, { prisma });
    const rows = createMany.mock.calls[0]![0].data as Array<{ channel: string; account_id: string | null }>;
    // x はニッチ一致で振り分け、note/blog は接続アカウント無しで null
    expect(rows.filter((r) => r.channel === 'x').every((r) => r.account_id === 'x-acct')).toBe(true);
    expect(rows.find((r) => r.channel === 'note')!.account_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// promotion.post.publish
// ---------------------------------------------------------------------------

type AnyArgs = Record<string, unknown>;

function publishPrisma(overrides: {
  post?: Record<string, unknown> | null;
  setting?: Record<string, unknown> | null;
  account?: Record<string, unknown> | null;
  casCount?: number;
}) {
  const update = vi.fn((_args: AnyArgs) => Promise.resolve({}));
  const updateMany = vi.fn((_args: AnyArgs) => Promise.resolve({ count: overrides.casCount ?? 1 }));
  const accountFindUnique = vi.fn((_args: AnyArgs) => Promise.resolve(overrides.account ?? null));
  const prisma = {
    promotionPost: {
      findUnique: vi.fn((_args: AnyArgs) => Promise.resolve(overrides.post ?? null)),
      updateMany,
      update,
    },
    promotionChannelSetting: {
      findUnique: vi.fn((_args: AnyArgs) => Promise.resolve(overrides.setting ?? null)),
    },
    promotionAccount: {
      findUnique: accountFindUnique,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { update, updateMany, accountFindUnique, prisma };
}

describe('runPromotionPostPublish', () => {
  it('auto_enabled チャンネルの scheduled 投稿を publish し posted に更新', async () => {
    const { prisma, update } = publishPrisma({
      post: { id: 'p1', channel: 'sns', title: null, body: '本文', status: 'scheduled' },
      setting: { auto_enabled: true, handle: '@me', token_enc: null, config_json: {} },
    });
    const res = await runPromotionPostPublish(
      { post_id: 'p1' },
      { prisma, resolvePort: () => createStubPublisherPort('https://x.test/1'), now: () => new Date('2026-07-08T00:00:00Z') },
    );
    expect(res).toEqual({ status: 'posted', externalUrl: 'https://x.test/1' });
    const finalUpdate = update.mock.calls.at(-1)![0] as { data: { status: string; external_url: string } };
    expect(finalUpdate.data.status).toBe('posted');
    expect(finalUpdate.data.external_url).toBe('https://x.test/1');
  });

  it('auto_enabled=false ならスキップ (実投稿しない)', async () => {
    const { prisma, updateMany } = publishPrisma({
      post: { id: 'p1', channel: 'sns', title: null, body: '本文', status: 'scheduled' },
      setting: { auto_enabled: false, handle: null, token_enc: null, config_json: null },
    });
    const port = { publish: vi.fn() };
    const res = await runPromotionPostPublish({ post_id: 'p1' }, { prisma, resolvePort: () => port });
    expect(res).toEqual({ status: 'skipped', reason: 'auto_disabled' });
    expect(port.publish).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled(); // CAS まで到達しない
  });

  it('scheduled でない投稿はスキップ', async () => {
    const { prisma } = publishPrisma({
      post: { id: 'p1', channel: 'sns', title: null, body: 'x', status: 'posted' },
    });
    const res = await runPromotionPostPublish({ post_id: 'p1' }, { prisma });
    expect(res).toEqual({ status: 'skipped', reason: 'status_posted' });
  });

  it('未接続チャンネルは failed(not_connected) を記録', async () => {
    const { prisma, update } = publishPrisma({
      post: { id: 'p1', channel: 'note', title: 'T', body: '本文', status: 'scheduled' },
      setting: { auto_enabled: true, handle: null, token_enc: null, config_json: {} },
    });
    const res = await runPromotionPostPublish(
      { post_id: 'p1' },
      { prisma, resolvePort: () => createNotConnectedPublisherPort() },
    );
    expect(res.status).toBe('failed');
    const finalUpdate = update.mock.calls.at(-1)![0] as { data: { status: string; error: string } };
    expect(finalUpdate.data.status).toBe('failed');
    expect(finalUpdate.data.error).toContain('not_connected');
  });

  it('token_enc があれば復号して config.token に渡す', async () => {
    const publish = vi.fn((_a: AnyArgs) => Promise.resolve({ ok: true as const, externalUrl: null }));
    const { prisma } = publishPrisma({
      post: { id: 'p1', channel: 'sns', title: null, body: 'x', status: 'scheduled' },
      setting: { auto_enabled: true, handle: '@me', token_enc: 'ENC', config_json: { webhook_url: 'https://h' } },
    });
    await runPromotionPostPublish(
      { post_id: 'p1' },
      { prisma, resolvePort: () => ({ publish } as unknown as PublisherPort), decryptToken: () => 'SECRET' },
    );
    const arg = publish.mock.calls[0]![0] as { config: { token: string; extra: Record<string, unknown> } };
    expect(arg.config.token).toBe('SECRET');
    expect(arg.config.extra.webhook_url).toBe('https://h');
  });

  it('P4: account_id 付き投稿は接続済み台帳アカウントの資格情報で投稿する', async () => {
    const publish = vi.fn((_a: AnyArgs) => Promise.resolve({ ok: true as const, externalUrl: 'https://x.test/9' }));
    const { prisma, accountFindUnique } = publishPrisma({
      post: { id: 'p1', channel: 'x', account_id: 'acct-1', title: null, body: 'x', status: 'scheduled' },
      setting: { auto_enabled: true, handle: '@channel', token_enc: 'CHAN', config_json: {} },
      account: { status: 'connected', handle: '@niche', token_enc: 'ACCT', config_json: { webhook_url: 'https://a' } },
    });
    await runPromotionPostPublish(
      { post_id: 'p1' },
      { prisma, resolvePort: () => ({ publish } as unknown as PublisherPort), decryptToken: (e) => `dec:${e}` },
    );
    expect(accountFindUnique).toHaveBeenCalled();
    const arg = publish.mock.calls[0]![0] as { config: { token: string; handle: string | null } };
    // チャンネル既定(CHAN)ではなくアカウント(ACCT)のトークン/ハンドルを使う
    expect(arg.config.token).toBe('dec:ACCT');
    expect(arg.config.handle).toBe('@niche');
  });

  it('P4: account_id 付きだがアカウント未接続なら failed(account_not_connected)', async () => {
    const publish = vi.fn();
    const { prisma, update } = publishPrisma({
      post: { id: 'p1', channel: 'x', account_id: 'acct-1', title: null, body: 'x', status: 'scheduled' },
      setting: { auto_enabled: true, handle: '@channel', token_enc: 'CHAN', config_json: {} },
      account: { status: 'pending', handle: null, token_enc: null, config_json: null },
    });
    const res = await runPromotionPostPublish(
      { post_id: 'p1' },
      { prisma, resolvePort: () => ({ publish } as unknown as PublisherPort) },
    );
    expect(res.status).toBe('failed');
    expect((res as { reason: string }).reason).toBe('account_not_connected');
    expect(publish).not.toHaveBeenCalled();
    expect((update.mock.calls.at(-1)![0] as { data: { status: string } }).data.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// promotion.dispatch
// ---------------------------------------------------------------------------

describe('runPromotionDispatch', () => {
  it('auto-enabled チャンネルの期限到来分を publish に流す', async () => {
    const addJob = vi.fn(async () => ({}));
    const findMany = vi.fn((_a: AnyArgs) => Promise.resolve([{ id: 'p1', channel: 'sns' }, { id: 'p2', channel: 'note' }]));
    const prisma = {
      promotionChannelSetting: { findMany: vi.fn(async () => [{ channel: 'sns' }, { channel: 'note' }]) },
      promotionPost: { findMany },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const res = await runPromotionDispatch({ prisma, addJob, now: () => new Date('2026-07-08T12:00:00Z') });
    expect(res.enqueued).toBe(2);
    expect(addJob).toHaveBeenCalledWith('promotion.post.publish', { post_id: 'p1' });
    expect(addJob).toHaveBeenCalledWith('promotion.post.publish', { post_id: 'p2' });
    // フィルタ条件を検証
    const where = findMany.mock.calls[0]![0].where as Record<string, unknown>;
    expect(where.status).toBe('scheduled');
    expect(where.book).toEqual({ publish_status: 'published' });
    expect(where.channel).toEqual({ in: ['sns', 'note'] });
  });

  it('auto-enabled チャンネルが無ければ何もしない', async () => {
    const addJob = vi.fn();
    const prisma = {
      promotionChannelSetting: { findMany: vi.fn(async () => []) },
      promotionPost: { findMany: vi.fn() },
    };
    const res = await runPromotionDispatch({ prisma, addJob });
    expect(res.enqueued).toBe(0);
    expect(prisma.promotionPost.findMany).not.toHaveBeenCalled();
  });

  it('1 件の enqueue 失敗が他を止めない', async () => {
    const addJob = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({});
    const prisma = {
      promotionChannelSetting: { findMany: vi.fn(async () => [{ channel: 'sns' }]) },
      promotionPost: { findMany: vi.fn(async () => [{ id: 'p1', channel: 'sns' }, { id: 'p2', channel: 'sns' }]) },
    };
    const res = await runPromotionDispatch({ prisma, addJob });
    expect(res.enqueued).toBe(1);
    expect(res.failed).toBe(1);
  });
});
