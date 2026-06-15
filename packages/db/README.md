# @a2p/db

Prisma スキーマ・マイグレーション・`prisma` シングルトンの単一供給源。
詳細は `docs/05-program-design.md` §3 を参照。

## 構成

```
packages/db/
├─ schema.prisma                 # 30 model (docs/05 §3 全文)
├─ index.ts                      # PrismaClient シングルトン (docs/05 §13 #1)
├─ seed.ts                       # 初期 seed (AppSettings/Prompts/ModelAssignments/User)
├─ generated/                    # prisma generate 出力（.gitignore 済み）
├─ migrations/
│  ├─ migration_lock.toml
│  ├─ 20260521000000_init/                 # 30 テーブル CREATE
│  └─ 20260521000001_add_partial_uniques/  # 手書きパーシャル UNIQUE
└─ __tests__/
   ├─ schema.test.ts             # スキーマ/マイグレーション網羅性チェック
   └─ seed.test.ts               # seed 関数の単体テスト (mock prisma)
```

## 必要環境変数

- `DATABASE_URL` — PostgreSQL 16 への接続文字列。例: `postgresql://postgres:postgres@localhost:5432/a2p_dev`

## 開発者の初回セットアップ

### 1. ローカル PostgreSQL を用意

いずれか好きな方法で：

```bash
# Docker
docker run -d --name a2p-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=a2p_dev \
  -p 5432:5432 \
  postgres:16
```

または Railway / Supabase の Postgres を使う場合は `DATABASE_URL` をその接続文字列に差し替えるだけでよい。

### 2. マイグレーション適用

```bash
# 既存マイグレーション 2 件 (init + add_partial_uniques) を順に適用
pnpm --filter @a2p/db migrate:deploy
```

開発中にスキーマを変更する場合は：

```bash
# 編集 → 差分マイグレーション生成 + 適用 + クライアント再生成
pnpm --filter @a2p/db migrate:dev --name <change-summary>
```

### 3. Prisma Client を生成

`pnpm install` 時に自動実行される（`@prisma/client` の postinstall）が、明示的にやるなら：

```bash
pnpm --filter @a2p/db generate
```

### 4. 初期データを seed

マイグレーション適用後に：

```bash
pnpm --filter @a2p/db seed
# あるいはリポジトリルートから:
pnpm db:seed
```

seed の内容（docs/05 §13 #9）:

- `AppSettings` (id='singleton') — コスト閾値・通知設定・AI 開示文ほか既定値
- `Prompt` — 役割 × ジャンルの最小 v1 アクティブ版（marketer/judge/optimizer は genre=null、
  writer/editor/thumbnail_text/thumbnail_image は practical/business/self_help の 3 件ずつ）
- `ModelAssignment` — docs/01 §7.3 初期推奨表（7 役 × genre=null）
- `User` × 1 — env `AUTH_USERNAME` / `AUTH_PASSWORD_HASH`（bcrypt 済）が両方設定されている場合のみ

全件 upsert で **冪等**。複数回実行しても行は増えない。`Prompt` 本文や `ModelAssignment.model` を
運営者/Optimizer が後から書き換えた場合、それらは seed 再実行で **上書きされない**（system 印のみ復帰）。

`AppSettings.ai_disclosure_text` の初期文言は仮置き（docs/05 OQ-D-07）。本番運用前に KDP 最新規約に
合わせて S-027 で更新すること。

### 5. graphile-worker スキーマ初期化

graphile-worker は専用の `graphile_worker` PostgreSQL スキーマを使う。
Worker プロセス (`apps/worker`) の `run()` を最初に起動した時点で graphile-worker が自動的に CREATE するため、運用上は **追加作業不要**。

明示的に事前に作成したい場合は graphile-worker CLI で：

```bash
npx graphile-worker --connection "$DATABASE_URL" --schema-only
```

これは `apps/worker` パッケージから実行する（graphile-worker は worker 側の依存）。

## docs/05 との整合

- §3 の 30 model がそのまま `schema.prisma` に転記されている（unit test で件数チェック）
- §3.2 のパーシャル UNIQUE 2 本は `20260521000001_add_partial_uniques/migration.sql` に手書きされている
- §13 #1 のシングルトンパターンを `index.ts` で実装
- §14 #5 の通り、`accounts.kdp_credentials_enc` 等 Phase 3 用カラムは Phase 1 で nullable のまま先取り

## スキーマ変更時の注意

- 編集は必ず `docs/05 §3` を同時更新する（プログラム設計が一次正本）
- `prisma format` でフォーマット統一
- パーシャル UNIQUE 等 Prisma DSL で表現不能なものは新規マイグレーションを `--create-only` で空生成し、手書き SQL を入れる
