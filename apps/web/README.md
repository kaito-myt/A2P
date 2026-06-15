# @a2p/web

A2P の Next.js 15 (App Router) フロントエンド + Server Actions / Route Handlers。

## Phase 1 SP-01 (T-01-09) で実装した範囲

- Next.js 15 + React 19 アプリ初期化 (`apps/web/`)
- Auth.js v5 (next-auth ^5) Credentials Provider + Prisma 連携
- ログイン画面 S-001 (`app/(auth)/login/page.tsx`)
- 5 回失敗で 15 分ロック (F-043 受け入れ基準) — `lib/auth-service.ts`
- `getSessionOrThrow()` (docs/05 §13 #8) — `lib/auth-helpers.ts`
- `middleware.ts` で `/login` 以外を保護
- セッション期限 30 日 (JWT 戦略)
- 暫定ホーム `/` (T-01-10 で S-002 ダッシュボードに置換予定)

T-01-10 で Tailwind + shadcn/ui + デザイントークン基盤を導入する。本タスクは
最小 CSS Variable で済ませているため、T-01-10 でルックを置換しても URL/挙動は
変わらない。

## 開発

```sh
# 依存インストール（T-01-09 時点で next/react/next-auth/bcryptjs 追加）
pnpm install

# 型チェック
pnpm --filter @a2p/web typecheck

# ユニットテスト
pnpm --filter @a2p/web test:unit

# dev サーバ起動 (DB が必要)
pnpm --filter @a2p/web dev
```

## 環境変数

`packages/contracts/src/env.ts` で検証。本タスクで使うキー:

- `AUTH_USERNAME` — シングルユーザー名
- `AUTH_PASSWORD_HASH` — bcryptjs ハッシュ
- `NEXTAUTH_SECRET` — 32 bytes hex (`openssl rand -hex 32`)
- `NEXTAUTH_URL` — 本番のみ必須
- `NEXT_PUBLIC_APP_URL` — メール本文等で利用

パスワードハッシュ生成:

```sh
node -e "console.log(require('bcryptjs').hashSync('YOUR_PASSWORD', 12))"
```

## アーキテクチャメモ

### Edge / Node 分離

Auth.js v5 は Prisma + bcrypt が Edge ランタイムで動かないため、

- `auth.config.ts` — providers なしの **Edge 互換** 設定 (middleware 用)
- `auth.ts` — Credentials Provider + Prisma を追加した **Node** 用 NextAuth インスタンス

middleware からは `auth.config.ts` のみを参照する。
https://authjs.dev/guides/edge-compatibility

### 認証ロジックのテスト容易性

Auth.js の SSR 経路をフルに mock するのは脆いため、5 回ロック等のコアロジックは
`lib/auth-service.ts` の純関数 `verifyCredentialsAndUpdateCounters(input, deps)`
に分離。`authorize()` はそのアダプタにすぎない。Vitest では prisma を mock した
deps を渡してテストする (`__tests__/auth-service.test.ts`)。
