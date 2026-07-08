/**
 * F-052b — 所有ブログの PublisherPort 実装。
 *
 * 第三者プラットフォームではなく **ツール自身のブログ** (blog_posts テーブル + 公開 /blog ページ)
 * に投稿するため、外部接続なしで「作成〜運用まで完全自律」できる。
 * publish() は blog_posts 行を published で作成し、公開 URL を返す。
 */
import { randomUUID } from 'node:crypto';

import { prisma as defaultPrisma } from '@a2p/db';

import type { PublishInput, PublishResult, PublisherPort } from './publisher-port.js';

export interface BlogPublisherDeps {
  prisma?: {
    blogPost: {
      create: (args: {
        data: {
          slug: string;
          title: string;
          body_md: string;
          status: string;
          published_at: Date;
        };
      }) => Promise<{ slug: string }>;
    };
  };
  /** 公開 URL のベース (例: https://app.example.com)。未設定なら相対 URL を返す。 */
  baseUrl?: string;
  now?: () => Date;
  generateSlug?: () => string;
}

function defaultSlug(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

export function createBlogPublisherPort(deps: BlogPublisherDeps = {}): PublisherPort {
  const prisma = deps.prisma ?? (defaultPrisma as unknown as NonNullable<BlogPublisherDeps['prisma']>);
  const now = deps.now ?? (() => new Date());
  const genSlug = deps.generateSlug ?? defaultSlug;
  const baseUrl = (deps.baseUrl ?? process.env.PROMOTION_BLOG_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');

  return {
    async publish(input: PublishInput): Promise<PublishResult> {
      const body = input.body?.trim();
      if (!body) {
        return { ok: false, reason: 'invalid', message: 'empty blog body' };
      }
      const title = input.title?.trim() || '新刊のお知らせ';

      // slug 衝突は稀 (10 hex)。念のため数回リトライ。
      let slug = genSlug();
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const row = await prisma.blogPost.create({
            data: { slug, title, body_md: body, status: 'published', published_at: now() },
          });
          const url = baseUrl ? `${baseUrl}/blog/${row.slug}` : `/blog/${row.slug}`;
          return { ok: true, externalUrl: url };
        } catch (err) {
          // unique 衝突なら slug を変えて再試行、それ以外は失敗扱い。
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < 2 && /unique|P2002/i.test(msg)) {
            slug = genSlug();
            continue;
          }
          return { ok: false, reason: 'unknown', message: msg };
        }
      }
      return { ok: false, reason: 'unknown', message: 'slug generation exhausted' };
    },
  };
}
