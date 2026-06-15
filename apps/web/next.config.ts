import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // workspace パッケージは Next.js でトランスパイルが必要
  transpilePackages: ['@a2p/contracts', '@a2p/crypto', '@a2p/db', '@a2p/ui'],
  // graphile-worker は内部で動的 require / cosmiconfig による preset 解決を行うため
  // Next.js webpack でバンドルされると plugin が undefined になり
  // `Expected plugin, but found 'undefined'` で失敗する。
  // Node の require 解決へ委ねるため server external にする (T-02-10 follow-up)。
  // 併せて graphile-worker が依存する pg 系も外部化しておく。
  serverExternalPackages: ['graphile-worker', 'pg', 'pg-native'],
  experimental: {
    // Server Actions の最大ペイロード等は SP-02 以降で調整
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  // `packages/*` 内の TypeScript ソースは ES Module 規約 (NodeNext) に
  // 合わせるため `from './foo.js'` の拡張子付き相対 import を採用している
  // (T-01-09 / T-01-10 で確立した規約)。
  // 一方 Next.js の webpack はその `.js` をリテラルに解決しようとして失敗する
  // ため、Server Action / Client Component が `@a2p/*` を取り込む経路で
  // 拡張子エイリアスを張り、`.js → .ts(x)` に解決させる。
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    };
    return config;
  },
};

export default nextConfig;
