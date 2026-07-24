/**
 * 低品質本 間引きレビュー画面。
 *
 * 週次 `book.cull.detect`(売上低迷) が抽出した候補を一覧し、運営者が承認(取り下げ)/却下(残す)する。
 * 取り下げは KDP からの出版停止+アーカイブ(破壊的)なので、この人間ゲートを必ず通す。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { listCullCandidates } from '@/app/actions/book-cull';
import { CullReviewClient } from '@/components/books/cull-review-client';

export const metadata: Metadata = { title: '低品質本の間引きレビュー | A2P' };
export const dynamic = 'force-dynamic';

export default async function BookCullPage() {
  const candidates = await listCullCandidates();

  return (
    <div className="flex flex-col gap-space-loose" data-testid="book-cull-page">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">ホーム</Link>
          <span aria-hidden="true"> &gt; </span>
          <Link href="/books" className="no-underline hover:underline">書籍</Link>
          <span aria-hidden="true"> &gt; </span>
          <span>取り下げレビュー</span>
        </nav>
        <div>
          <h1 className="text-sub-heading text-foreground">低品質本の間引きレビュー</h1>
          <p className="text-body text-muted">
            売上が低迷している公開済み書籍の取り下げ候補です。承認すると KDP から
            <b>出版停止＋アーカイブ</b>（Amazon 上で非公開・本棚から除外／復元可）を自動実行します。
            残す本は「残す」で候補から外します。
          </p>
        </div>
      </header>

      <CullReviewClient candidates={candidates} />
    </div>
  );
}
