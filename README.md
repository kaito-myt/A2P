# A2P — Amazon Automated Publishing

個人運用の Amazon KDP 出版自動化ツール。テーマ提案・本文執筆・校閲・サムネ生成までを複数の AI エージェントが分担し、Word / PDF / PNG として出力する。

開発自体もハーネス化されており、Claude Code のサブエージェント群が業務要件 → E2E まで分担して進める。

## Phase 0 状況（現在）

ハーネス整備フェーズ。コードはまだ無く、設計ドキュメントと開発ワークフローを整える段階です。

```
.claude/
  agents/                10 個のハーネスエージェント
    biz-requirements.md
    functional-requirements.md
    tech-selection.md
    ui-design.md
    program-design.md
    designer.md
    pm.md
    programmer.md
    code-reviewer.md
    e2e-tester.md
  commands/
    iterate.md           実装→レビューを APPROVED まで回すスラッシュコマンド
docs/
  01-business-requirements.md   ← biz-requirements が記入
  02-functional-requirements.md ← functional-requirements が記入
  03-tech-selection.md          ← tech-selection が記入
  04-ui-design.md               ← ui-design が記入
  05-program-design.md          ← program-design が記入
  wireframes/                   ← designer が記入
  dev-plan.md                   ← pm が記入
  sprints/                      ← pm が記入
CLAUDE.md                       プロジェクト全体ガイド
```

## ハーネスの使い方

### 1. 設計ドキュメントを順番に生成

依存関係: `01 → 02 → 03 と 04 → 05 → dev-plan/sprints`。Claude Code で以下のように 1 つずつ実行してください（前段が完成していないと後段は意味のあるアウトプットを返しません）。

```
/agents
> biz-requirements         # docs/01 を作成
> functional-requirements  # docs/02 を作成
> tech-selection           # docs/03 を作成
> ui-design                # docs/04 を作成
> designer                 # docs/wireframes/ を作成
> program-design           # docs/05 を作成
> pm                       # docs/dev-plan.md と docs/sprints/SP-01-*.md を作成
```

または対話で `biz-requirements エージェントを呼んで docs/01 を初版作成して` と依頼。

### 2. 実装ループを回す

スプリントが切られたら、各タスクを `/iterate` に渡す：

```
/iterate T-01-03
```

または

```
/iterate "Add /api/health route returning {ok: true}"
```

内部で `programmer → code-reviewer` が最大 5 回ループし、`APPROVED` で完了します。

### 3. E2E テスト

機能が一段落したら：

```
> e2e-tester エージェントを呼んで F-001 のハッピーパスを書いて
```

## Railway デプロイ手順

> 📘 **運用の正典は [`docs/operations/runbook.md`](./docs/operations/runbook.md)** です。
> デプロイ手順 / 環境変数チェックリスト (29 項目) / 障害復旧 / pg_dump 復元 / モニタリング指針を網羅しています。
> 以下は概要。詳細・トラブルシュートは runbook を参照してください。

A2P は Railway の 1 プロジェクト内に **Web (Next.js) + Worker (graphile-worker) + PostgreSQL** の 3 サービスを同居させる構成です。

### 1. Railway プロジェクト作成

1. <https://railway.app> にログインし、**New Project** → **Deploy from GitHub repo** で本リポジトリを選択
2. 初回検出されたサービスを `web` にリネーム (Next.js を自動検出)
3. **+ New** から **Database → PostgreSQL** を追加 (`postgres` サービスとして起動)
4. **+ New** から **Empty Service** を追加し、`worker` にリネーム

### 2. リポジトリ設定 (サービスごと)

すべてのサービスで Settings → Source → **Repository = 本リポジトリ / Root Directory = `/`** を設定し、**Watch Paths** で対象パスを限定して不要なデプロイを抑止します。

| サービス | ビルダー | Build Command | Start Command | Watch Paths |
|---|---|---|---|---|
| `web` | Nixpacks (自動) | `pnpm install --frozen-lockfile && pnpm --filter @a2p/db generate && pnpm --filter @a2p/web build` | `pnpm --filter @a2p/web start` | `apps/web/**`, `packages/**`, `package.json`, `pnpm-lock.yaml` |
| `worker` | **Dockerfile (`apps/worker/Dockerfile`)** | (Dockerfile 内で定義) | (Dockerfile `CMD` で定義: `pnpm --filter @a2p/worker start`) | `apps/worker/**`, `packages/**`, `package.json`, `pnpm-lock.yaml` |
| `postgres` | Railway 標準テンプレート | — | — | — |

`web` は `package.json` の `engines.node` と `packageManager` を Nixpacks が尊重するため、Node 22 / pnpm 9 が自動選択されます。`worker` は `pg_dump` を同梱する必要があるため Dockerfile ビルドを採用しており、Railway は `apps/worker/Dockerfile` を自動検出します (Service Settings → Source → Dockerfile Path に `apps/worker/Dockerfile` を明示的に指定することも可能)。

### 3. リリースフック (DB マイグレーション)

`web` サービスの Settings → Deployments → **Pre-Deploy Command** に以下を設定します:

```
pnpm --filter @a2p/db migrate:deploy
```

これにより `apps/web` のデプロイごとに `prisma migrate deploy` が自動実行され、本番 DB スキーマが追従します (`docs/03 §I-03`)。

> 初回 seed (`pnpm db:seed`) は **手動** で 1 度だけ実行します。Railway の `web` サービスの **Run a command** から `pnpm db:seed` を実行してください。

### 4. 環境変数 (28 項目)

`.env.example` の全 28 項目を Railway の各サービスの Variables に登録します。`postgres` サービスから払い出される `DATABASE_URL` は **Reference Variable** 機能で `web` / `worker` に自動注入できます (`${{ postgres.DATABASE_URL }}`)。

主要な変数 (詳細は `.env.example` / `docs/03 §5`):

| 変数 | 設定先 | 備考 |
|---|---|---|
| `NODE_ENV=production` | web / worker | |
| `DATABASE_URL` | web / worker | `${{ postgres.DATABASE_URL }}` で参照 |
| `NEXTAUTH_SECRET` | web | `openssl rand -hex 32` で生成 |
| `NEXTAUTH_URL` | web | Railway 払い出しドメイン or カスタムドメイン |
| `NEXT_PUBLIC_APP_URL` | web / worker | メール本文/2FA 承認 URL 用。worker からは Resend 本文生成で参照 |
| `AUTH_USERNAME` / `AUTH_PASSWORD_HASH` | web | bcryptjs で生成したハッシュ |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` | web / worker | |
| `R2_*` (5 項目) | web / worker | Cloudflare R2 |
| `RESEND_API_KEY` / `MAIL_FROM` / `MAIL_TO` | web / worker | |
| `KDP_CRED_KEY` | web / worker | Phase 3 から必須 (`openssl rand -hex 32`) |
| `LOG_LEVEL` / `WORKER_BOOK_CONCURRENCY` / `WORKER_CHAPTER_CONCURRENCY` | worker | 任意 (既定 info / 5 / 4) |
| `MODEL_CATALOG_FETCH_CRON` / `FX_RATE_API_URL` | worker | 任意 |
| `COST_LIMIT_PER_BOOK_JPY` / `COST_LIMIT_MONTHLY_JPY` | web / worker | 任意 |

> CI で `pnpm check:env` が走り、`.env.example` と zod スキーマの差分があれば red になります (`docs/03 §J-03`)。

### 5. ヘルスチェック

`web` サービスの Settings → Networking → **Healthcheck Path = `/api/health`** を設定。返却は `{ ok: true, db: 'ok' }` で 200 を期待します (実装は T-01-09 系の API ルート)。

`worker` サービスは graphile-worker の内蔵 health (Postgres への接続維持) で生死判定します。プロセス異常終了時に Railway が自動再起動します。

### 6. DB バックアップ (R-12 緩和)

`worker` サービスは **毎週土曜 18:00 UTC (= 日曜 03:00 JST)** に `archive.db.backup` cron を起動し、`pg_dump` の結果を `archive/db/{yyyy-mm-dd}.sql.gz` として Cloudflare R2 に退避します。Railway 障害時はこの SQL を `psql` で復元してください (復元手順は [`docs/operations/runbook.md` §4.3](./docs/operations/runbook.md) / `docs/dev-plan.md` R-12)。

> `worker` イメージには `pg_dump` (Postgres 16 系) が必要です。本リポジトリでは `apps/worker/Dockerfile` を同梱し、`postgresql-client-16` を `apt-get` で導入しています。Railway は `apps/worker/` 配下に `Dockerfile` がある場合これを自動採用するため、追加設定不要で `pg_dump` が利用可能になります。

### 7. ローカル動作確認

```bash
pnpm install
cp .env.example .env.local        # 値を埋める
pnpm --filter @a2p/db migrate:dev # 初回マイグレーション
pnpm db:seed                       # 初期データ投入
pnpm --filter @a2p/web dev         # http://localhost:3000
pnpm --filter @a2p/worker dev      # 別タブで graphile-worker 起動
```

## ロードマップ

| フェーズ | 内容 | 状態 |
|---|---|---|
| Phase 0 | ハーネス整備 + 設計書 01〜05 完成 | 🚧 進行中 |
| Phase 1 | MVP: Marketer→Writer→Editor→Thumbnail パイプライン、Word/PDF/PNG 出力、Railway デプロイ | ⏳ |
| Phase 2 | Quality Judge + プロンプトバージョニング + 売上トラッキング + Prompt Optimizer | ⏳ |
| Phase 3 | Playwright で KDP 登録自動化 | ⏳ |
| Phase 4 | note 記事など別出力チャネル | ⏳ |

詳細は `docs/dev-plan.md`（生成後）参照。

## 技術スタック（決定済み）

Next.js 15 / TypeScript / Railway / PostgreSQL / Prisma / graphile-worker / Claude Agent SDK / OpenAI gpt-image-1 / Cloudflare R2 / NextAuth / Tailwind + shadcn/ui / Vitest + Playwright

理由と代替案は `docs/03-tech-selection.md`（生成後）参照。

## ライセンス

個人利用のプライベートプロジェクト。
