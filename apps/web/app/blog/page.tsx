/**
 * 所有ブログ 一覧 (F-052b) — 公開ページ (未認証で閲覧可)。販促で自動投稿された記事が並ぶ。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'ブログ',
  description: '最新の記事一覧',
};

export default async function BlogIndexPage() {
  const posts = await prisma.blogPost.findMany({
    where: { status: 'published' },
    orderBy: [{ published_at: 'desc' }],
    take: 100,
    select: { slug: true, title: true, published_at: true, body_md: true },
  });

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-5 py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-charcoal">ブログ</h1>
        <p className="text-body text-muted">最新の記事</p>
      </header>

      {posts.length === 0 ? (
        <p className="text-body text-muted">まだ記事がありません。</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border-warm">
          {posts.map((p) => (
            <li key={p.slug} className="py-4">
              <Link href={`/blog/${p.slug}`} className="group flex flex-col gap-1 no-underline">
                <span className="text-lg font-medium text-charcoal group-hover:text-accent">{p.title}</span>
                <span className="text-caption text-muted">
                  {p.published_at ? new Date(p.published_at).toLocaleDateString('ja-JP') : ''}
                </span>
                <span className="line-clamp-2 text-body text-charcoal-82">
                  {p.body_md.replace(/[#*_>`-]/g, '').slice(0, 120)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
