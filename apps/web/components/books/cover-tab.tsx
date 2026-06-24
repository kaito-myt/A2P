'use client';

/**
 * S-010 書籍詳細「カバー」タブ。
 *
 * 生成済みカバー画像 (covers) をグリッド表示する。画像は R2 (非公開) に保存され、
 * `/api/covers/{id}/image` が署名 URL へ 302 リダイレクトして配信する。
 * next/image の最適化は Cookie 非送出で middleware に弾かれるため素の <img> を使う。
 */
import { messages } from '@/lib/messages';
import type { BookCoverSerialized } from '@/lib/books-view';

const m = messages.books;

export function CoverTab({ covers }: { covers: BookCoverSerialized[] }) {
  if (covers.length === 0) {
    return (
      <div
        className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        data-testid="cover-tab-empty"
      >
        <p className="text-body text-muted">{m.cover.empty}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-space-relaxed" data-testid="cover-tab">
      {covers.map((cover, idx) => (
        <figure
          key={cover.id}
          className={`flex w-[200px] flex-col gap-2 rounded-card border p-space-snug ${
            cover.status === 'adopted'
              ? 'border-charcoal bg-cream'
              : 'border-border-warm bg-cream-light'
          }`}
          data-testid={`book-cover-${cover.id}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- R2 署名 URL への 302 を Cookie 付きで取得するため素の img */}
          <img
            src={cover.imageUrl}
            alt={m.cover.altLabel(idx + 1)}
            loading="lazy"
            className="h-[300px] w-full rounded-default border border-border-warm bg-cream object-contain"
          />
          <figcaption className="flex items-center justify-between text-caption text-muted">
            <span>{m.cover.candidateLabel(idx + 1)}</span>
            {cover.status === 'adopted' && (
              <span className="font-medium text-charcoal">{m.cover.adopted}</span>
            )}
            {cover.costJpy !== null && <span>¥{Math.round(cover.costJpy)}</span>}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
