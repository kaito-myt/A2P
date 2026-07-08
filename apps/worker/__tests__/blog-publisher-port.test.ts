/**
 * F-052b — 所有ブログ PublisherPort の単体テスト。
 */
import { describe, expect, it, vi } from 'vitest';

import { createBlogPublisherPort } from '../src/tasks/promotion-post/blog-publisher-port.js';

type AnyArgs = Record<string, unknown>;

function makePrisma(createImpl: (a: AnyArgs) => Promise<{ slug: string }>) {
  return { blogPost: { create: vi.fn(createImpl) } };
}

const input = {
  channel: 'blog' as const,
  title: '副業の始め方',
  body: '# 見出し\n本文です。',
  config: { token: null, handle: null, extra: {} },
};

describe('createBlogPublisherPort', () => {
  it('blog_posts に published で作成し、baseUrl 付き公開 URL を返す', async () => {
    const prisma = makePrisma(async (a) => ({ slug: (a.data as { slug: string }).slug }));
    const port = createBlogPublisherPort({
      prisma,
      baseUrl: 'https://app.test/',
      now: () => new Date('2026-07-08T00:00:00Z'),
      generateSlug: () => 'abc123',
    });
    const res = await port.publish(input);
    expect(res).toEqual({ ok: true, externalUrl: 'https://app.test/blog/abc123' });
    const created = prisma.blogPost.create.mock.calls[0]![0].data as AnyArgs;
    expect(created).toMatchObject({ slug: 'abc123', title: '副業の始め方', status: 'published' });
  });

  it('baseUrl 未設定なら相対 URL を返す', async () => {
    const prisma = makePrisma(async (a) => ({ slug: (a.data as { slug: string }).slug }));
    const port = createBlogPublisherPort({ prisma, baseUrl: '', generateSlug: () => 'zzz' });
    const res = await port.publish(input);
    expect(res).toEqual({ ok: true, externalUrl: '/blog/zzz' });
  });

  it('空本文は invalid で失敗', async () => {
    const prisma = makePrisma(async () => ({ slug: 's' }));
    const port = createBlogPublisherPort({ prisma });
    const res = await port.publish({ ...input, body: '   ' });
    expect(res.ok).toBe(false);
  });

  it('slug 衝突(P2002)なら別 slug で再試行する', async () => {
    let calls = 0;
    const slugs = ['dup', 'fresh'];
    const prisma = {
      blogPost: {
        create: vi.fn(async (a: AnyArgs) => {
          calls += 1;
          if (calls === 1) throw new Error('Unique constraint failed (P2002)');
          return { slug: (a.data as { slug: string }).slug };
        }),
      },
    };
    let i = 0;
    const port = createBlogPublisherPort({ prisma, baseUrl: '', generateSlug: () => slugs[i++]! });
    const res = await port.publish(input);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.externalUrl).toBe('/blog/fresh');
    expect(calls).toBe(2);
  });
});
