/**
 * 書籍カタログ (公開ページ) — SNS プロフィールのリンク先 (link in bio)。
 * 出版済み書籍を表紙付きで並べ、Amazon 購入ページへ導線する。未認証で閲覧可。
 */
import type { Metadata } from 'next';

import { prisma } from '@a2p/db';
import { getSignedDownloadUrl } from '@a2p/storage';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '書籍一覧',
  description: 'これまでに出版した書籍の一覧。気になる一冊を Amazon でどうぞ。',
};

function amazonUrl(asin: string): string {
  return `https://www.amazon.co.jp/dp/${asin}`;
}

export default async function BooksLandingPage() {
  const books = await prisma.book.findMany({
    where: { publish_status: 'published', asin: { not: null } },
    orderBy: [{ updated_at: 'desc' }],
    take: 100,
    select: {
      id: true,
      title: true,
      subtitle: true,
      asin: true,
      covers: { where: { status: 'adopted' }, select: { r2_key: true }, take: 1 },
    },
  });

  const items = await Promise.all(
    books.map(async (b) => {
      const key = b.covers[0]?.r2_key;
      const coverUrl = key ? await getSignedDownloadUrl(key, 900).catch(() => null) : null;
      return { ...b, coverUrl };
    }),
  );

  return (
    <div className="min-h-screen bg-cream">
      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-5 py-12">
        <header className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-charcoal">書籍一覧</h1>
          <p className="text-body text-muted">気になる一冊を Amazon（Kindle）でどうぞ。Kindle Unlimited なら読み放題対象も。</p>
        </header>

        {items.length === 0 ? (
          <p className="py-12 text-center text-muted">現在ご紹介できる書籍はまだありません。</p>
        ) : (
          <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            {items.map((b) => (
              <li
                key={b.id}
                className="flex gap-4 rounded-card border border-border-warm bg-cream-light p-4 shadow-l1"
              >
                <div className="h-32 w-[86px] shrink-0 overflow-hidden rounded-default bg-charcoal-04">
                  {b.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={b.coverUrl} alt={b.title} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-caption text-muted">
                      表紙
                    </div>
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <h2 className="line-clamp-3 text-button-sm font-bold text-charcoal">{b.title}</h2>
                  {b.subtitle && <p className="line-clamp-2 text-caption text-muted">{b.subtitle}</p>}
                  <a
                    href={amazonUrl(b.asin as string)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-auto inline-flex w-fit items-center rounded-card bg-accent px-3 py-1.5 text-caption font-medium text-cream-light hover:opacity-80"
                  >
                    Amazon で見る →
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
