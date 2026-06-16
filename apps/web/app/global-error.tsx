'use client';

/**
 * App Router のグローバルエラーバウンダリ。
 *
 * ルートレイアウトを置き換えるため、自前で <html>/<body> を描画する。
 * not-found.tsx と合わせて用意することで、`next build` のエラーページ
 * プリレンダー時に pages-router 既定 (`next/document`) へフォールバックして
 * 失敗する既知問題を回避する。環境変数・DB に依存しない。
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ja">
      <body className="font-sans">
        <main
          style={{
            minHeight: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
            padding: 24,
            textAlign: 'center',
          }}
        >
          <h1 style={{ fontSize: 22, fontWeight: 600 }}>エラーが発生しました</h1>
          <p style={{ color: '#6b6b6b', fontSize: 14 }}>
            問題が発生しました。時間をおいて再度お試しください。
          </p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              borderRadius: 8,
              padding: '8px 16px',
              fontSize: 14,
              background: '#2b2b2b',
              color: '#faf7f0',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            再試行
          </button>
        </main>
      </body>
    </html>
  );
}
