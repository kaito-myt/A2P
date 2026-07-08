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
import { createStubPublisherPort, createNotConnectedPublisherPort } from '../src/tasks/promotion-post/publisher-port.js';

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
  it('プランから SNS×2 / note×1 / blog×1 の投稿を日程付きで作る', async () => {
    const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const prisma = {
      promotionPlan: { findUnique: vi.fn(async () => ({ plan_json: PLAN })) },
      promotionPost: { deleteMany, createMany },
    };
    const now = () => new Date('2026-07-08T00:00:00Z');

    const res = await runPromotionPostsGenerate({ book_id: 'b1' }, { prisma, now });

    expect(res.created).toBe(4);
    const rows = createMany.mock.calls[0]![0].data as Array<{
      channel: string;
      scheduled_for: Date;
      title: string | null;
    }>;
    expect(rows.map((r) => r.channel).sort()).toEqual(['blog', 'note', 'sns', 'sns']);
    // sns#0 at base, sns#1 at +1day
    const sns = rows.filter((r) => r.channel === 'sns').sort((a, b) => +a.scheduled_for - +b.scheduled_for);
    expect(sns[0]!.scheduled_for.toISOString()).toBe('2026-07-08T00:00:00.000Z');
    expect(sns[1]!.scheduled_for.toISOString()).toBe('2026-07-09T00:00:00.000Z');
    const note = rows.find((r) => r.channel === 'note');
    expect(note!.title).toBe('note見出し');
  });

  it('未投稿の既存分を削除してから作り直す (冪等)', async () => {
    const deleteMany = vi.fn(async () => ({ count: 3 }));
    const prisma = {
      promotionPlan: { findUnique: vi.fn(async () => ({ plan_json: PLAN })) },
      promotionPost: { deleteMany, createMany: vi.fn(async (a: { data: unknown[] }) => ({ count: a.data.length })) },
    };
    const res = await runPromotionPostsGenerate({ book_id: 'b1' }, { prisma });
    expect(deleteMany).toHaveBeenCalledWith({ where: { book_id: 'b1', status: { in: ['scheduled', 'draft'] } } });
    expect(res.removed).toBe(3);
  });

  it('プランが無ければ何もしない', async () => {
    const prisma = {
      promotionPlan: { findUnique: vi.fn(async () => null) },
      promotionPost: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const res = await runPromotionPostsGenerate({ book_id: 'b1' }, { prisma });
    expect(res).toEqual({ created: 0, removed: 0 });
    expect(prisma.promotionPost.deleteMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// promotion.post.publish
// ---------------------------------------------------------------------------

function publishPrisma(overrides: {
  post?: Record<string, unknown> | null;
  setting?: Record<string, unknown> | null;
  casCount?: number;
}) {
  const update = vi.fn(async () => ({}));
  const updateMany = vi.fn(async () => ({ count: overrides.casCount ?? 1 }));
  return {
    update,
    updateMany,
    prisma: {
      promotionPost: {
        findUnique: vi.fn(async () => overrides.post ?? null),
        updateMany,
        update,
      },
      promotionChannelSetting: {
        findUnique: vi.fn(async () => overrides.setting ?? null),
      },
    },
  };
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
    const publish = vi.fn(async () => ({ ok: true as const, externalUrl: null }));
    const { prisma } = publishPrisma({
      post: { id: 'p1', channel: 'sns', title: null, body: 'x', status: 'scheduled' },
      setting: { auto_enabled: true, handle: '@me', token_enc: 'ENC', config_json: { webhook_url: 'https://h' } },
    });
    await runPromotionPostPublish(
      { post_id: 'p1' },
      { prisma, resolvePort: () => ({ publish }), decryptToken: () => 'SECRET' },
    );
    const arg = publish.mock.calls[0]![0] as { config: { token: string; extra: Record<string, unknown> } };
    expect(arg.config.token).toBe('SECRET');
    expect(arg.config.extra.webhook_url).toBe('https://h');
  });
});

// ---------------------------------------------------------------------------
// promotion.dispatch
// ---------------------------------------------------------------------------

describe('runPromotionDispatch', () => {
  it('auto-enabled チャンネルの期限到来分を publish に流す', async () => {
    const addJob = vi.fn(async () => ({}));
    const findMany = vi.fn(async () => [{ id: 'p1', channel: 'sns' }, { id: 'p2', channel: 'note' }]);
    const prisma = {
      promotionChannelSetting: { findMany: vi.fn(async () => [{ channel: 'sns' }, { channel: 'note' }]) },
      promotionPost: { findMany },
    };
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
