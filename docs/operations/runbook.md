# A2P 運用ハンドブック (Runbook)

> Phase 1 (MVP) 対象。SP-09 T-09-09 / R-05・R-12 対応。
> 本書は **Railway 本番環境** での A2P の初回デプロイ・日常運用・障害復旧手順を、
> 運営者 1 名が再現できる粒度で記述する。

関連ドキュメント:

- 環境変数の正典: [`.env.example`](../../.env.example) (全 29 項目) / 検証スキーマ: `packages/contracts/src/env.ts`
- アーキ全体像: `docs/03-tech-selection.md` / `docs/05-program-design.md` §5 (ジョブ/cron)
- 実走コスト実測: [`docs/operations/phase1-real-run.md`](./phase1-real-run.md) (T-09-08)

---

## 0. 構成サマリ

| サービス | 役割 | ビルド | 起動 |
|---|---|---|---|
| **Web** | Next.js 15 (UI + API routes + NextAuth) | Railway Nixpacks (リポジトリ標準ビルド) | `pnpm --filter @a2p/web start` |
| **Worker** | graphile-worker (パイプライン + cron) | `apps/worker/Dockerfile` (Railway が自動検出) | `pnpm --filter @a2p/worker start` |
| **Postgres** | アプリ DB + ジョブキュー (graphile-worker) | Railway managed Postgres 16 | — |
| **Cloudflare R2** | 成果物 (docx/pdf/png) + DB/ジョブのアーカイブ | 外部 (S3 互換) | — |

> Web と Worker は **同一 `DATABASE_URL` を共有**する。graphile-worker のキューは
> アプリと同じ Postgres に同居する (Redis 不要)。R2 だけが Railway 外。

---

## 1. 初回デプロイ手順

### 1.1 事前準備 (ローカル)

1. Cloudflare R2 バケットを作成 (`a2p-artifacts` 等)。S3 互換アクセスキーを発行。
2. 各種シークレットを生成:
   ```bash
   # NEXTAUTH_SECRET / KDP_CRED_KEY / API_CRED_KEY 用 (各 64 hex)
   openssl rand -hex 32
   # AUTH_PASSWORD_HASH (bcrypt, cost 12)
   node -e "console.log(require('bcryptjs').hashSync('YOUR_PASSWORD', 12))"
   ```
3. (任意) Resend API キー (メール通知)、Sentry DSN (監視) を取得。

### 1.2 Railway プロジェクト作成

1. Railway で新規プロジェクト → **Postgres** プラグインを追加。
   `DATABASE_URL` が自動発行される (Web / Worker から参照)。
2. **Web サービス**を追加 → GitHub リポジトリを接続。
   - Root は monorepo ルート。Nixpacks が `pnpm` workspace を検出。
   - Build command (必要なら明示): `pnpm install --frozen-lockfile && pnpm --filter @a2p/db generate && pnpm --filter @a2p/web build`
   - Start command: `pnpm --filter @a2p/web start`
3. **Worker サービス**を追加 → 同リポジトリを接続。
   - Railway は `apps/worker/Dockerfile` を自動検出してこれでビルドする
     (pg_dump 16 系を同梱済み — R-12 の DB バックアップに必須)。
   - Start command は Dockerfile の `CMD` (`pnpm --filter @a2p/worker start`) を使用。

### 1.3 環境変数の登録

`.env.example` の全 29 項目を Railway Variables に登録する。**§2 のチェックリスト**を使用。
Web / Worker の両サービスに同じ値を設定する (特に `DATABASE_URL`, `*_CRED_KEY`, R2 系)。

### 1.4 マイグレーション & シード

初回のみ、DB スキーマ適用とシード投入を行う。Railway のサービスシェル
(または `DATABASE_URL` を本番値にしてローカル) から:

```bash
# スキーマ適用 (本番は dev ではなく deploy)
pnpm --filter @a2p/db migrate:deploy
# 初期データ (operator ユーザー / プロンプト 32 版 / AppSettings singleton 等)
pnpm --filter @a2p/db seed
```

> `migrate:deploy` は未適用マイグレーションのみを冪等に適用する。再デプロイ毎に
> 流しても安全。**`migrate:reset` は本番で絶対に実行しない** (全データ破棄)。

### 1.5 デプロイ後の疎通確認 (スモーク)

- [ ] Web の `/` がロード → ログイン画面表示
- [ ] `AUTH_USERNAME` / 平文パスワードでログイン成功
- [ ] ダッシュボードが描画 (CostMeter / JobTicker が値を返す)
- [ ] Worker ログに `graphile-worker` 起動 + cron 登録 (6 件) が出力
- [ ] S-027 (API 認証情報) から LLM キーを登録 → 接続テスト OK
- [ ] 1 テーマ投入 → Marketer ジョブが queued → running に遷移 (Worker 稼働確認)

---

## 2. 環境変数チェックリスト (29 項目)

正典は [`.env.example`](../../.env.example)。本番では Railway Variables に登録。
キーの追加/削除は `packages/contracts/src/env.ts` と同時に行い、`pnpm tsx scripts/check-env-example.ts` で差分検出する。

| # | キー | 必須 | 区分 | 備考 |
|---|---|---|---|---|
| 1 | `NODE_ENV` | ✅ | 実行 | 本番は `production` |
| 2 | `DATABASE_URL` | ✅ | DB | Railway Postgres が自動発行。Web/Worker 共通 |
| 3 | `NEXTAUTH_SECRET` | ✅ | 認証 | `openssl rand -hex 32` |
| 4 | `NEXTAUTH_URL` | ✅(本番) | 認証 | 例 `https://a2p.example.com` |
| 5 | `NEXT_PUBLIC_APP_URL` | ✅ | 認証 | フロント参照可。メール/2FA リンク用 |
| 6 | `AUTH_USERNAME` | ✅ | 認証 | 既定 `operator` |
| 7 | `AUTH_PASSWORD_HASH` | ✅ | 認証 | bcrypt cost 12。**平文を入れない** |
| 8 | `ANTHROPIC_API_KEY` | △ | LLM | 通常は UI(S-027)→DB 登録。env はフォールバック |
| 9 | `OPENAI_API_KEY` | △ | LLM | サムネ生成 (gpt-image-1)。同上 |
| 10 | `GOOGLE_GENERATIVE_AI_API_KEY` | △ | LLM | 同上 |
| 11 | `TAVILY_API_KEY` | ✕ | LLM | Phase 2+ Web 検索フォールバック。空可 |
| 12 | `R2_ACCOUNT_ID` | ✅ | R2 | |
| 13 | `R2_ACCESS_KEY_ID` | ✅ | R2 | |
| 14 | `R2_SECRET_ACCESS_KEY` | ✅ | R2 | シークレット |
| 15 | `R2_BUCKET_NAME` | ✅ | R2 | 例 `a2p-artifacts` |
| 16 | `R2_PUBLIC_URL_BASE` | ✅ | R2 | 成果物 DL リンク基底 |
| 17 | `RESEND_API_KEY` | △ | メール | 未設定ならメール無効 (graceful fallback) |
| 18 | `MAIL_FROM` | △ | メール | Resend 利用時必須 |
| 19 | `MAIL_TO` | △ | メール | 運営者宛先 |
| 20 | `KDP_CRED_KEY` | ✕(P1) | 暗号 | Phase 3 必須。空可 |
| 21 | `API_CRED_KEY` | ✅ | 暗号 | UI 登録 LLM キーの AES-256-GCM 鍵。空だと保存時 ConfigError |
| 22 | `SENTRY_DSN` | ✕ | 監視 | 空なら Sentry 無効 |
| 23 | `LOG_LEVEL` | ✕ | 監視 | 既定 `info` |
| 24 | `WORKER_BOOK_CONCURRENCY` | ✕ | 並列 | 既定 5 |
| 25 | `WORKER_CHAPTER_CONCURRENCY` | ✕ | 並列 | 既定 4 |
| 26 | `MODEL_CATALOG_FETCH_CRON` | ✕ | cron | 既定 `0 19 * * *` (JST 04:00) |
| 27 | `FX_RATE_API_URL` | ✕ | 為替 | 既定 open.er-api.com |
| 28 | `COST_LIMIT_PER_BOOK_JPY` | ✕ | コスト | 既定 500 |
| 29 | `COST_LIMIT_MONTHLY_JPY` | ✕ | コスト | 既定 50000 |

凡例: ✅=必須 / △=条件付き必須 / ✕=任意。
**シークレット (3,7,14,17,20,21 と LLM キー) は git に commit しない** (CLAUDE.md Hard Rule 6)。

---

## 3. 定期ジョブ (cron) 一覧

`apps/worker/src/crontab.ts` が正典。graphile-worker の cron は **UTC ベース**。

| identifier | タスク | スケジュール (UTC) | JST | 用途 |
|---|---|---|---|---|
| `batch-plan-dispatcher-minute` | `batch.plan.dispatcher` | `* * * * *` | 毎分 | 予約バッチの起動チェック (F-021) |
| `alert-cost-check-hourly` | `alert.cost.check` (monthly) | `0 * * * *` | 毎時 | 月次コスト予測アラート + 期限切れ BookLock 掃除 (piggyback) |
| `fx-fetch-daily` | `fx.fetch` | `55 18 * * *` | 03:55 | 為替レート取得 |
| `catalog-fetch-daily` | `catalog.fetch` | `0 19 * * *`(既定) | 04:00 | 単価カタログ取得 (env で可変) |
| `archive-db-backup-weekly` | `archive.db.backup` | `0 18 * * 6` | 日 03:00 | pg_dump → R2 (R-12) |
| `archive-jobs-weekly` | `archive.jobs` | `0 18 * * 6` | 日 03:00 | 90 日超 Job を R2 退避 + DB 削除 |

> per_book スコープのコストチェックはパイプラインから個別 enqueue されるため cron には無い。

---

## 4. 障害復旧

### 4.1 `prisma migrate deploy` 失敗時

1. ログで失敗マイグレーション名と SQL エラーを特定。
2. **`P3009` (failed migration が記録されている)**: 原因 SQL を手動で是正後、
   ```bash
   pnpm --filter @a2p/db prisma migrate resolve --applied <migration_name>
   # もしくはロールバック相当なら --rolled-back
   ```
   で状態を整合させ、再度 `migrate:deploy`。
3. **drift (スキーマと履歴の不一致)**: 本番では `migrate:reset` 禁止。
   バックアップから復元 (§4.3) → 正しいマイグレーション履歴で再適用。
4. 解決まで Web/Worker の再デプロイは保留 (古いイメージで稼働継続させる)。

### 4.2 Worker が動かない / ジョブが滞留

- Worker サービスログを確認。`DATABASE_URL` 不一致が最頻原因。
- graphile-worker の起動ログ (cron 6 件登録) が出ているか。
- 滞留ジョブ: S-025 (ジョブログ一覧) で `failed` を確認 → 一括リトライ。
  または S-026 で「ステップから再開」。
- 期限切れ BookLock が掃けず書籍がロックされたまま →
  `alert-cost-check-hourly` が毎時掃除する。緊急時は該当 `book_locks` 行を手動削除。

### 4.3 DB バックアップからの復元 (pg_dump / R2)

週次バックアップは R2 の `archive/db/{yyyy-mm-dd}.sql.gz` に gzip SQL で保存される
(`apps/worker/src/tasks/archive-db-backup.ts`)。復元手順:

```bash
# 1. R2 から該当日のダンプを取得 (rclone / aws s3 cp --endpoint-url=<R2>)
aws s3 cp s3://a2p-artifacts/archive/db/2026-06-07.sql.gz ./restore.sql.gz \
  --endpoint-url "https://<account>.r2.cloudflarestorage.com"

# 2. 展開
gunzip restore.sql.gz   # → restore.sql

# 3. 新しい空 DB (または復旧先) に流し込む
psql "$DATABASE_URL" < restore.sql
```

> pg_dump は Worker イメージ (PostgreSQL 16) で取得しているため、復元先も 16 系を推奨。
> 復元後は `pnpm --filter @a2p/db migrate:deploy` で最新マイグレーションとの差分を確認。

### 4.4 ジョブログのアーカイブ復元

`archive.jobs` は 90 日超の Job 行を R2 `archive/jobs/{yyyy-mm}.jsonl.gz` (JSONL+gzip) に退避後
DB から削除する。過去ジョブの調査が必要なら該当月の JSONL を R2 から取得して参照
(DB への再投入は不要 — 監査用途の追跡のみ)。

---

## 5. モニタリング指針

| 指標 | 見る場所 | 閾値 / アクション |
|---|---|---|
| 月次コスト | S-018 (コスト詳細) / CostMeter | 予測が黄(80%)/橙(95%)/赤(100%) でアラート。赤=`monthly_budget_exceeded` で自動停止 |
| 1 冊あたりコスト | S-026 TokenUsageInline / Book.cost_status | 500 円=warn / 750 円=paused_cost (自動キャンセル) |
| ジョブ成功率 | S-025 JobStatsCard | 直近 24h 成功率が落ちたら failed を調査 |
| Worker 稼働 | Railway メトリクス + Worker ログ | クラッシュループ時は env / DB 接続を確認 |
| エラー | Sentry (`SENTRY_DSN` 設定時) | fatal/error を通知 |
| メール通知 | Resend ダッシュボード | コスト超過 / DB バックアップ失敗が届くか |

- `LOG_LEVEL` は本番 `info` 推奨。調査時のみ一時的に `debug`。
- 全 LLM/画像呼び出しは `token_usage` に記録される (CLAUDE.md Hard Rule 5)。
  コスト異常時はここを `getBookCostBreakdown` / S-018 で分解する。

---

## 6. KDP 規約変更時の AI 開示文更新手順 (R-05)

KDP の AI 生成コンテンツ開示ポリシーが変わった場合:

1. 影響範囲を確認 (開示文言 / メタデータ項目 / 表紙要件)。
2. プロンプトテンプレ (DB `prompts` テーブル) を S-022 (プロンプト管理) から改訂し、
   新バージョンを active 化する (コードにハードコードしない — Hard Rule 4)。
3. KDP 入稿チェックリスト (S-019) の開示確認項目を更新。
4. 既刊で再開示が必要なら該当書籍を再入稿フローに乗せる。

---

## 7. 日常運用チートシート

```bash
# マイグレーション状態確認
pnpm --filter @a2p/db prisma migrate status

# 新規マイグレーション適用 (本番)
pnpm --filter @a2p/db migrate:deploy

# Prisma Studio で DB を直接閲覧 (ローカルから本番 DATABASE_URL に注意)
pnpm --filter @a2p/db studio

# env.example と zod スキーマの整合チェック
pnpm tsx scripts/check-env-example.ts

# テスト全件 (デプロイ前ゲート)
pnpm -r test:unit            # Vitest
pnpm exec playwright test    # E2E (実 PG 必要)
```
