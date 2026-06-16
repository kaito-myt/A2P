import Link from 'next/link';

/**
 * App Router の 404 ページ。
 *
 * 明示的に用意することで、Next.js が pages-router 既定のエラーページ
 * (`next/document` の `<Html>` を import する) にフォールバックして
 * `next build` の /404・/_error プリレンダーで失敗する既知問題を回避する。
 * 環境変数・DB に依存しない純粋な静的ページにしておく。
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-cream px-6 text-center">
      <p className="text-display text-charcoal-82">404</p>
      <h1 className="text-card-title text-charcoal">ページが見つかりませんでした</h1>
      <p className="text-button-sm text-muted">
        お探しのページは存在しないか、移動した可能性があります。
      </p>
      <Link
        href="/dashboard"
        className="rounded-default bg-charcoal px-4 py-2 text-button-sm text-cream no-underline hover:opacity-90"
      >
        ダッシュボードへ戻る
      </Link>
    </main>
  );
}
