/**
 * 所有ブログ 記事 (F-052b) — 公開ページ (未認証で閲覧可)。
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { prisma } from '@a2p/db';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = await prisma.blogPost.findUnique({ where: { slug }, select: { title: true, body_md: true } });
  if (!post) return { title: '記事が見つかりません' };
  return { title: post.title, description: post.body_md.replace(/[#*_>`-]/g, '').slice(0, 140) };
}

/** ごく軽量な Markdown → 要素変換 (見出し/箇条書き/段落のみ)。外部依存なし。 */
function renderMarkdown(md: string) {
  const lines = md.split('\n');
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flushList = (key: number) => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`ul-${key}`} className="my-3 list-disc pl-6 text-charcoal-82">
        {list.map((li, i) => (
          <li key={i}>{li}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    if (/^#{1,2}\s+/.test(line)) {
      flushList(idx);
      blocks.push(
        <h2 key={idx} className="mt-6 text-xl font-bold text-charcoal">
          {line.replace(/^#{1,2}\s+/, '')}
        </h2>,
      );
    } else if (/^#{3,}\s+/.test(line)) {
      flushList(idx);
      blocks.push(
        <h3 key={idx} className="mt-4 text-lg font-semibold text-charcoal">
          {line.replace(/^#{3,}\s+/, '')}
        </h3>,
      );
    } else if (/^[-*]\s+/.test(line)) {
      list.push(line.replace(/^[-*]\s+/, ''));
    } else if (line.trim().length === 0) {
      flushList(idx);
    } else {
      flushList(idx);
      blocks.push(
        <p key={idx} className="my-3 leading-relaxed text-charcoal-82">
          {line}
        </p>,
      );
    }
  });
  flushList(lines.length);
  return blocks;
}

export default async function BlogPostPage({ params }: PageProps) {
  const { slug } = await params;
  const post = await prisma.blogPost.findUnique({ where: { slug } });
  if (!post || post.status !== 'published') notFound();

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-5 py-12">
      <Link href="/blog" className="text-button-sm text-muted underline underline-offset-4 hover:no-underline">
        ← ブログ一覧
      </Link>
      <article className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight text-charcoal">{post.title}</h1>
        <p className="text-caption text-muted">
          {post.published_at ? new Date(post.published_at).toLocaleDateString('ja-JP') : ''}
        </p>
        <div className="mt-4">{renderMarkdown(post.body_md)}</div>
      </article>
    </main>
  );
}
