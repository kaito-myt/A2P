# SP-01 bootstrap-monorepo

## 1. 目的

A2P の実装基盤（pnpm モノレポ / Next.js 15 + worker / Prisma + Postgres / NextAuth 認証 / Pino ロガー / Resend メール / R2 ストレージ / 環境変数検証）を確立し、`apps/web` の最小ダッシュボードと `apps/worker` の最小タスクが Railway 上で起動できる状態にする。Phase 1 全スプリントの土台。

## 2. 対応機能 ID

- **F-043** シングルユーザー認証（NextAuth Credentials、env パスワード）
- **F-044** KDP アカウント（ペンネーム）の登録・編集
- インフラ全般：`docs/03 §J` env 管理、`docs/03 §G-01` Pino、`docs/03 §D` Resend、`docs/03 §C-10` R2、`docs/03 §C-04` graphile-worker、`docs/05 §13` 申し送り 1〜10 のうち #1〜#3, #7〜#10
- 対応画面: **S-001** ログイン、**S-002** ダッシュボード（骨格のみ）、**S-003** アカウント一覧、**S-004** アカウント詳細

## 3. タスク一覧

| ID | 状態 | タスク | 概要 | 対応機能/画面 | 工数 |
|---|---|---|---|---|---|
| T-01-01 | ✅ | pnpm workspace + tsconfig 基盤 | ルート `package.json` / `pnpm-workspace.yaml` / 共通 tsconfig / pnpm scripts | インフラ | S |
| T-01-02 | ✅ | `packages/contracts` env zod スキーマ + `.env.example` | `docs/03 §5` 28 項目を zod で定義、起動時 parse、CI 差分検出スクリプト | docs/03 申し送り 3 | M |
| T-01-03 | ✅ | `packages/db` Prisma schema 初期投入 + シングルトン | `docs/05 §3` の **30 model 全投入** + パーシャル UNIQUE 手書きマイグ + Prisma シングルトン | docs/05 申し送り 1, 10 | L |
| T-01-04 | ✅ | `packages/db` seed スクリプト | AppSettings / 既定 Prompts (役割×ジャンル) / 既定 ModelAssignments / 初期 User | docs/05 申し送り 9 | M |
| T-01-05 | ✅ | `packages/contracts` logger + 共通型 | Pino ファクトリ / `ActionResult<T>` / `A2PError` 派生 / redact 設定 + money.ts | docs/03 G-01, docs/05 §9.1 | S |
| T-01-06 | ✅ | `packages/storage` R2 クライアント + キー規約 | S3 互換クライアント / `keys.ts` (`docs/05 §8`) / 署名付き URL (900s) / SHA-256 / upload helper | docs/03 申し送り 5, docs/05 申し送り 7 | M |
| T-01-07 | ✅ | `packages/notify` Resend + react-email 基盤 + 4 テンプレ枠 | `email.ts` ラッパ / テンプレ枠 5 件（cost-exceeded / monthly-budget-alert / pricing-changed / revision-run-completed / db-backup-failed）+ レンダー関数 | docs/03 申し送り 7 | M |
| T-01-08 | ✅ | `packages/crypto` AES-256-GCM ヘルパ | `kdp-credentials.ts` の encrypt/decrypt（base64 単一文字列 + ValidationError ラップ） + 鍵検証 + 単体テスト | docs/03 KDP-04 (Phase 3 先取り) | S |
| T-01-09 | ✅ | `apps/web` NextAuth Credentials + S-001 ログイン画面 | Auth.js v5 / `getSessionOrThrow()` ヘルパ / 5 回失敗ロック (15 分) / safeCallbackUrl サニタイザ / S-001 実装 | F-043, docs/05 申し送り 8 | M |
| T-01-10 | ✅ | `apps/web` 共通レイアウト + S-002 ダッシュボード骨格 + **デザイントークン基盤** | Header(CostMeter/Alert/Comment Badge placeholder) + Sidebar + 空 S-002 / Tailwind + shadcn/ui 導入 + `packages/ui/tokens.ts` (§6.3) + Inter/Noto Sans JP (next/font) + shadcn テーマ上書き | S-002, docs/04 §3 §6.3, docs/03 §K | L |
| T-01-11 | ✅ | `apps/web` S-003/S-004 アカウント管理 | `actions/accounts.ts`（create/update/archive） + S-003 一覧 + S-004 詳細フォーム + KDP credentials SecretField (Phase 3 用 nullable) | F-044 | M |
| T-01-12 | ✅ | `apps/worker` graphile-worker 起動 + 19 タスク登録 + DB バックアップ cron | runner 起動 / 19 タスク (placeholder 17 + kickoff NOP + archive.db.backup) / `pg_dump` 土曜 18:00 UTC R2 退避 / Dockerfile (PG 16) / GitHub Actions CI (typecheck/test-unit/check-env/lint, pnpm-store cache) / Railway デプロイ手順 README | docs/03 §C-04, R-12, docs/03 §I | L |

合計 **12 タスク**、すべて完了（2026-05-22、`/iterate` ループで 19 iterations 累計）。

---

## 4. タスク詳細

各タスクは `/iterate "<T-NN-MM>"` で programmer に渡せるレベルで記述する。programmer は **必ず** `docs/05` の該当章を読んでから着手すること。

---

### T-01-01 pnpm workspace + tsconfig 基盤

**何を実装するか**:
- ルート `package.json` に `private: true`, `engines.node: ^22`, `packageManager: pnpm@9.x`, scripts: `lint` `typecheck` `test:unit` `test:e2e` `build` を定義
- `pnpm-workspace.yaml` に `apps/*` と `packages/*` を列挙
- ルート `tsconfig.base.json`（strict / `moduleResolution: bundler` / `target: ES2022` / `noUncheckedIndexedAccess: true`）。各パッケージは `extends`
- `.editorconfig` / `.gitignore`（`.env.*` 含む）
- `pnpm install` が通り `pnpm typecheck` が成功する空のリポを生成

**参照すべき設計書セクション**:
- `docs/05 §2` モノレポ構成
- `docs/03 §4` 依存バージョン方針

**完了の判定方法**:
- `pnpm install --frozen-lockfile` が成功
- `pnpm typecheck` が 0 個のエラーで完了（空パッケージのため）
- `.env.local` が `.gitignore` 対象になっている

---

### T-01-02 packages/contracts env zod スキーマ + .env.example

**何を実装するか**:
- `packages/contracts/env.ts` に `docs/03 §5` の **全 28 項目** を zod で定義
- `parseEnv(process.env)` を export し、`apps/web` と `apps/worker` の起動エントリで呼出
- 必須/任意の区別を zod で表現（任意項目は `.optional()` + デフォルト値）
- リポジトリルートに `.env.example` を配置し、28 項目をコメント付きで列挙
- CI 用スクリプト `scripts/check-env-example.ts` を追加し、`.env.example` のキー集合と zod スキーマのキー集合が一致するか検証

**参照すべき設計書セクション**:
- `docs/03 §5` 環境変数一覧
- `docs/03 §J-01〜J-03`
- `docs/05 §13 #2`

**完了の判定方法**:
- `tsx scripts/check-env-example.ts` が 0 終了
- 必須項目を欠いて起動するとアプリが `process.exit(1)` する（unit テスト）

---

### T-01-03 packages/db Prisma schema 初期投入 + シングルトン

**何を実装するか**:
- `packages/db/schema.prisma` に `docs/05 §3` の **30 model 全文** をそのまま転記
- `prisma generate` の出力先を `packages/db/generated/`
- `packages/db/index.ts` に `prisma` シングルトン（`docs/05 §13 #1` のコード片を使用）
- `prisma migrate dev --name init` で初期マイグ生成
- `migrations/<timestamp>_add_partial_uniques/migration.sql` に `docs/05 §3.2` の `model_assignments_role_genre_active_key` と `prompts_role_genre_active_key` の手書き UNIQUE を追加
- graphile-worker 用 `graphile_worker` schema の初期化手順を README に記載

**参照すべき設計書セクション**:
- `docs/05 §3` 全文（30 model）
- `docs/05 §3.1` graphile-worker テーブル
- `docs/05 §3.2` パーシャル UNIQUE
- `docs/05 §14 #2 #5` シングルトン / Phase 3 先取り

**完了の判定方法**:
- `prisma migrate dev` が成功
- 30 model（Prisma `models()` で数えて確認）
- パーシャル UNIQUE が `pg_indexes` で検出可能
- `import { prisma } from '@a2p/db'` が型推論で全 model 補完される

---

### T-01-04 packages/db seed スクリプト

**何を実装するか**:
- `packages/db/seed.ts` を作成し、以下を upsert:
  - `User` × 1（`AUTH_USERNAME` / `AUTH_PASSWORD_HASH` から）
  - `AppSettings`（id='singleton'、`docs/05 §3 AppSettings` の既定値）
  - `Account` サンプル 1 件（pen_name="default"）
  - `Prompts`（役割: marketer/writer/editor/judge/thumbnail_text/thumbnail_image/optimizer × ジャンル: practical/business/self_help/null）= 最低 7×4 = **28 件**。本文は短いプレースホルダで OK、後続スプリントで肉付け
  - `ModelAssignments`（`docs/01 §7.3` の初期推奨表どおり全 7 役 × ジャンル null = 7 件）
- `package.json` に `"db:seed": "tsx packages/db/seed.ts"` を追加
- Prisma の `prisma.config` で `seed` 設定

**参照すべき設計書セクション**:
- `docs/05 §13 #9` シードデータ
- `docs/01 §7.3` 初期推奨モデル表
- `CLAUDE.md` Hard Rule 4（プロンプトは DB）

**完了の判定方法**:
- 空 DB に `pnpm db:seed` 実行で 28 prompts + 7 assignments + 1 user + 1 settings + 1 account が作成
- 再実行で 0 件追加（upsert 冪等）
- `prompts` の active 制約違反が起きない

---

### T-01-05 packages/contracts logger + 共通型

**何を実装するか**:
- `packages/contracts/logger.ts` に Pino ファクトリ（`docs/05 §10.2` のコード片）。redact 設定必須
- `packages/contracts/api/result.ts` に `ActionResult<T>` 型
- `packages/contracts/errors.ts` に `A2PError` 派生 11 種（`docs/05 §9.1`）
- `packages/contracts/money.ts` に JPY 整数ヘルパ（OQ-D-02 暫定）
- 単体テスト: 各エラー型のシリアライズ / redact 動作

**参照すべき設計書セクション**:
- `docs/05 §9.1` 例外型一覧
- `docs/05 §10.2` Pino 設定
- `docs/05 §12 OQ-D-02`

**完了の判定方法**:
- Vitest で redact テストが PASS（password / kdp_credentials_enc がログに残らない）
- 各 A2PError 派生が `instanceof A2PError` を満たす

---

### T-01-06 packages/storage R2 クライアント + キー規約

**何を実装するか**:
- `packages/storage/r2.ts`: `@aws-sdk/client-s3` で R2 互換クライアント生成、`putObject` / `getObject` / `headObject` / `deleteObject` のラッパ
- `packages/storage/keys.ts`: `docs/05 §8` のキー規約を関数化（`bookManuscriptKey(bookId, kind)` 等）
- `packages/storage/signed-url.ts`: 既定 TTL 15 分の署名付き URL
- `packages/storage/upload.ts`: SHA-256 計算 + R2 PUT + `Artifact` レコード INSERT のヘルパ
- 単体テスト: LocalStack S3 互換コンテナ（Testcontainers）で upload → checksum 検証

**参照すべき設計書セクション**:
- `docs/05 §8` ファイルストレージ規約
- `docs/05 §13 #7` storage 経由のみ
- `docs/03 §C-10`

**完了の判定方法**:
- LocalStack を起動した Vitest テストが PASS（put → get → checksum 一致）
- 署名付き URL TTL が 15 分

---

### T-01-07 packages/notify Resend + react-email 基盤 + 4 テンプレ枠

**何を実装するか**:
- `packages/notify/email.ts`: Resend クライアントラッパ。`sendMail({ to, template, data })`
- `packages/notify/templates/` に react-email コンポーネント 4 種の **枠** を作成:
  - `cost-exceeded.tsx` (SP-07 で本実装)
  - `monthly-budget-alert.tsx` (SP-07)
  - `pricing-changed.tsx` (SP-02)
  - `revision-run-completed.tsx` (SP-06)
- 各テンプレは「件名 + 1〜2 段落の本文 + 関連 URL ボタン」程度の最小マークアップ
- `sendMail()` 内部で送信失敗を Alert に記録する仕組みは SP-07 で実装（このタスクではログ出力のみ）
- 単体テスト: 各テンプレが React コンポーネントとしてレンダー可能

**参照すべき設計書セクション**:
- `docs/03 §D-01 D-02`
- `docs/03 §10 申し送り 7`

**完了の判定方法**:
- `pnpm test:unit` で 4 テンプレのレンダーテストが PASS
- 開発環境で `sendMail({ template: 'pricing-changed' })` が Resend のテスト API キーで送信成功

---

### T-01-08 packages/crypto AES-256-GCM ヘルパ

**何を実装するか**:
- `packages/crypto/kdp-credentials.ts`: Node.js `crypto` の `createCipheriv('aes-256-gcm', ...)` で `encrypt(plaintext: string, key?: Buffer): string` / `decrypt(ciphertext: string, key?: Buffer): string`（object⇔string 変換は呼び出し側 SA の責務。本ヘルパは文字列入出力のみを扱う）
- 鍵は env `KDP_CRED_KEY`（32 bytes hex）から取得、起動時に長さ検証。テスト/将来の KMS 連携用に `key?: Buffer` の DI 経路も提供
- 暗号文フォーマット: `base64(iv || authTag || ciphertext)` 単一文字列（採用理由: DB 列長が hex 比 4/3 倍 ≒ vs 2 倍と削減でき、Postgres `text` 列で扱いやすく、`:` 分割不要で堅牢）
- 復号時 `decipher.final()` の GCM 認証失敗は `ValidationError` でラップして再 throw（`A2PError` 階層に統一し、呼び出し側 SA が `instanceof A2PError` で一元処理可能にする）
- 単体テスト: round-trip / 鍵不正で throw / authTag・ciphertext・IV 改ざん検出（いずれも `ValidationError`）

**参照すべき設計書セクション**:
- `docs/03 §KDP-04`
- `docs/02 F-044` 受け入れ基準
- `docs/05 §9.1` A2PError 階層

**完了の判定方法**:
- round-trip テスト PASS
- 改ざんテストで GCM auth 失敗が `ValidationError` として throw

**後続エージェントへの申し送り**:
- 暗号文フォーマットを当初の `<iv-hex>:<authTag-hex>:<ciphertext-hex>` から `base64(iv || authTag || ciphertext)` に変更した（DB 列長削減と分割不要化のため）。Phase 3 で KDP 認証情報を `accounts.kdp_credentials_enc` (text 列) に保存する SA は本フォーマットを前提とすること。
- API シグネチャは `string ⇔ string`。オブジェクト形（例: `{ email, password }`）の保存は呼び出し側で `JSON.stringify` / `JSON.parse` する。

---

### T-01-09 apps/web NextAuth Credentials + S-001 ログイン画面

**何を実装するか**:
- `apps/web/app/api/auth/[...nextauth]/route.ts`: Auth.js v5 Credentials Provider 設定
- bcrypt で `User.password_hash` を照合、失敗カウントを `User.failed_count` 加算、5 回で `locked_until = now + 15 分`
- `apps/web/lib/auth.ts` に `getSessionOrThrow()` ヘルパ
- `apps/web/app/(auth)/login/page.tsx` に S-001 実装（LoginForm + PasswordInput visibility toggle + ロック表示）
- `middleware.ts` で未ログイン時に `/login` リダイレクト

**参照すべき設計書セクション**:
- `docs/04 S-001`
- `docs/05 §13 #8` `getSessionOrThrow`
- `docs/02 F-043` 受け入れ基準

**完了の判定方法**:
- 正しい認証情報でログイン → S-002 へリダイレクト
- 5 回連続失敗で 15 分ロック発動
- セッション期限が 30 日

---

### T-01-10 apps/web 共通レイアウト + S-002 ダッシュボード骨格 + デザイントークン基盤

**何を実装するか**:

**[A] デザイントークン基盤** (`docs/04 §6.3` + `docs/03 §K` UI-01〜UI-04 の正本実装)

- `packages/ui/tokens.ts` を新規作成。`docs/04 §6.3` の全トークンを TypeScript として export：
  - 色: `cream` (#f7f4ed), `cream-light` (#fcfbf8), `charcoal` (#1c1c1c), `border-warm` (#eceae4), `muted` (#5f5f5d), `charcoal/` opacity スケール (03/04/40/82/83/100)
  - semantic: destructive/warning/success/accent の 700 系
  - 余白: `space-tight..space-display` の 8 段階
  - radius: `micro/default/snug/card/container/pill`
  - shadow: `L2-inset` (Primary Dark の signature) / `L3-focus`
  - タイポ: ロール別 size/weight/line-height/letter-spacing
- `packages/ui/fonts.ts` を新規作成。`next/font/google` で **Inter** (Variable, weight 400/500/600) と **Noto Sans JP** (Variable, weight 400/500/600) を読み込み、CSS Variables (`--font-inter`, `--font-noto-jp`) を export。`display: 'swap'` 指定
- `apps/web/tailwind.config.ts` の `theme.extend` で `packages/ui/tokens.ts` を import し、`colors`, `spacing`, `borderRadius`, `boxShadow`, `fontFamily`, `fontSize`, `letterSpacing` を展開
- `apps/web/app/globals.css` の `:root` で shadcn の CSS Variables (`--background`, `--foreground`, `--primary`, `--border`, `--ring`, ...) を §6.3 値に差し替え。`--background: var(--cream)`, `--foreground: var(--charcoal)`, `--border: var(--border-warm)` の方針
- `apps/web/components.json` を作成: `style: "default"`, `cssVariables: true`, `baseColor: "neutral"`, `tailwind.config: tailwind.config.ts`
- `apps/web/app/layout.tsx` の `<html>` に `className={inter.variable + ' ' + notoJp.variable + ' font-sans'}` を適用

**[B] shadcn/ui コンポーネント導入とテーマ上書き確認**

- `npx shadcn add button card badge table input dialog dropdown-menu sheet tabs alert` で必要なコンポーネント生成
- 生成された `apps/web/components/ui/*.tsx` を `packages/ui/components/` に移動（CLAUDE.md の `packages/` 集約原則に従う）
- 各コンポーネントが §6.3 トークンを使ってレンダリングされていることを目視確認（背景が cream、ボタンが charcoal + L2 Inset shadow）

**[C] 共通レイアウト**

- `apps/web/app/(app)/layout.tsx` に Header + Sidebar（`docs/04 §3` 構造どおり）
- Header に `CostMeter` / `AlertBadge` / `CommentBadge` の **プレースホルダ** コンポーネント（中身は 0 表示、SP-06/SP-07 で本実装）。Header 自体は §6.3.5 L1 Bordered で `border-warm` 1px 下罫線
- Sidebar の階層ナビゲーション（`docs/04 §3.3`）。Phase 1 で未実装の画面はリンク disabled。Sidebar 下部に `JobTicker` プレースホルダ (`docs/04 §6.4.7`)

**[D] S-002 ダッシュボード骨格**

- `apps/web/app/(app)/dashboard/page.tsx` に S-002 の **6 セクション骨格** を空状態 + EmptyState で配置
- 参照: `docs/wireframes/S-002-dashboard/prompt.md`（運営者が ChatGPT で生成するワイヤー）
- カードは `radius-card` (12px) + `1px solid border-warm`、shadow なし（§6.3.5 L1 Bordered）

**参照すべき設計書セクション**:
- `docs/04 §3` 共通レイアウト
- **`docs/04 §6.3` デザイントークン（正本）**
- **`docs/04 §6.4` コンポーネントスタイル指針**
- **`docs/04 §6.5` Do / Don't**（特に「純白を使わない」「drop-shadow を使わない」）
- `docs/04 S-002`
- **`docs/03 §K UI-01〜UI-04` フォント・トークン管理戦略**
- `docs/05 §1.4` SSE 方針（このタスクでは未実装、placeholder のみ）

**完了の判定方法**:
- `/dashboard` の背景が **cream (#f7f4ed)** で表示される（純白ではない）
- フォントが Inter (英数字) + Noto Sans JP (日本語) で読み込まれている（DevTools Network で `inter-latin-*.woff2` と `noto-sans-jp-japanese-*.woff2` を確認）
- Primary Dark ボタンに **L2 Inset shadow** が visible（白い上端ハイライト + 下の暗いリング）
- カードに drop-shadow が無く、`border-warm` (#eceae4) 細枠のみで containment されている
- Header/Sidebar/6 セクションが視認でき、Sidebar の未実装画面リンクが disabled
- `packages/ui/tokens.ts` の TypeScript export が `apps/web/tailwind.config.ts` で型エラーなく import できる
- Lighthouse Performance > 80（空ページのため）

---

### T-01-11 apps/web S-003/S-004 アカウント管理

**何を実装するか**:
- `apps/web/app/actions/accounts.ts` に `createAccount` / `updateAccount` / `archiveAccount` の SA（`docs/05 §4.3.1` の zod schema 完全準拠）
- SA 内で `getSessionOrThrow()` + zod parse + `audit_log` INSERT
- KDP credentials は `packages/crypto` で encrypt し `accounts.kdp_credentials_enc` に保存
- `apps/web/app/(app)/accounts/page.tsx` (S-003): AccountsTable + AddAccountButton
- `apps/web/app/(app)/accounts/[id]/page.tsx` (S-004): AccountForm + SecretField + AccountKpiCard（KPI は 0 でも可、後続スプリントで本実装）
- Phase 1 は 1 アカウントで運用するが、UI は複数対応構造
- 参照: `docs/wireframes/S-003-accounts/prompt.md` / `docs/wireframes/S-004-account-detail/prompt.md`

**参照すべき設計書セクション**:
- `docs/04 S-003 S-004`
- `docs/05 §4.3.1` Account SA
- `docs/02 F-044` 受け入れ基準

**完了の判定方法**:
- 新規アカウント作成 → DB に 1 件追加 + `audit_log` 記録
- KDP credentials がマスク表示で平文を返さない
- 編集 → 暗号文が変更される

---

### T-01-12 apps/worker graphile-worker 起動 + DB バックアップ cron

**何を実装するか**:
- `apps/worker/src/index.ts`: graphile-worker `run({ connectionString, taskList, crontab, concurrency: env.WORKER_BOOK_CONCURRENCY })`
- `apps/worker/src/tasks/` に空タスク雛形を **18 ファイル** 配置（`docs/05 §2` の `tasks/*.ts` 全件、中身は `logger.info('task placeholder')` のみ）
- `apps/worker/src/crontab.ts` に `docs/05 §5.4` の cron 定義
- 追加 cron: `0 18 * * 6` (土曜 18:00 UTC = 毎週日曜 03:00 JST) で `pg_dump` を R2 退避するタスク `archive.db.backup`
- `apps/worker/Dockerfile` に Node 22 + libvips（後続 sharp 用）+ Chromium は **Phase 3 で追加**（コメントだけ）
- `.github/workflows/ci.yml` に lint / typecheck / vitest の並列ジョブ + `check-env-example.ts` ジョブ
- README の `docs/sprints/SP-01-bootstrap-monorepo.md` の最後に Railway デプロイ手順を追記（Web + Worker + Postgres + 環境変数 28 項目）

**参照すべき設計書セクション**:
- `docs/05 §2` モノレポ構成 (tasks/*.ts)
- `docs/05 §5.4` crontab
- `docs/03 §I-01〜I-04` CI/CD
- リスク R-12 DB バックアップ

**完了の判定方法**:
- `pnpm --filter @a2p/worker dev` で worker が起動し crontab が表示される
- GitHub Actions CI で lint/typecheck/vitest が PASS
- Railway 上で web + worker が deploy され `/api/health` が 200

---

## 5. テスト計画

### 5.1 Vitest（unit / integration）

| ファイル | 対象 | 内容 |
|---|---|---|
| `packages/contracts/__tests__/env.test.ts` | T-01-02 | 必須項目欠落で throw / 任意項目省略でデフォルト適用 |
| `packages/contracts/__tests__/logger.test.ts` | T-01-05 | password / kdp_credentials_enc が redact される |
| `packages/contracts/__tests__/errors.test.ts` | T-01-05 | 11 種の派生 error が `instanceof A2PError` を満たす |
| `packages/db/__tests__/schema.test.ts` | T-01-03 | Testcontainers で migrate 後、30 model が存在 / パーシャル UNIQUE 動作 |
| `packages/db/__tests__/seed.test.ts` | T-01-04 | seed 実行で 28 prompts + 7 assignments / 再実行で冪等 |
| `packages/storage/__tests__/r2.test.ts` | T-01-06 | LocalStack で put/get/checksum 検証 |
| `packages/storage/__tests__/keys.test.ts` | T-01-06 | キー規約関数の出力検証 |
| `packages/notify/__tests__/templates.test.tsx` | T-01-07 | 4 テンプレが React レンダー可能 |
| `packages/crypto/__tests__/kdp-credentials.test.ts` | T-01-08 | round-trip / 改ざん検出 / 鍵不正 throw |
| `apps/web/__tests__/auth.test.ts` | T-01-09 | 5 回失敗ロック動作 / セッション期限 |
| `apps/web/__tests__/actions/accounts.test.ts` | T-01-11 | create/update/archive の zod 検証 + audit_log INSERT |

### 5.2 Playwright（E2E）

**Playwright スモークは SP-09 (`e2e-deploy-harden`) へ繰越**（SP-01 完了確認時の判断、2026-05-22 確定）。理由:
- スモーク E2E 実行には PostgreSQL 接続が必要だが、SP-01 完了時点ではローカル DB をセットアップしていない開発者でも全 unit テストが green になる構成を優先
- Playwright 環境（`playwright.config.ts` + `tests/e2e/`）の整備自体を SP-09 で `@playwright/test` 導入と合わせて一括対応する方が、関連設定の二度手間を回避できる

SP-09 で以下を一括実装:
- `apps/web/playwright.config.ts`、`tests/e2e/` ディレクトリ、`@playwright/test ^1.50` devDep
- `tests/e2e/smoke-login-dashboard.spec.ts`（旧 SP-01 §5.2 で予定していた内容、ログイン → S-002 → S-003 → S-004 → DB 反映確認）
- UC-01〜UC-06 の本格 E2E（SP-09 本来のスコープ）
- 必要な `data-testid` 追加（apps/web 既存コンポーネントへの注釈）

本 SP-01 では Vitest による単体テストでデータ層・SA 層・認証ロジックを担保し、`pnpm --filter @a2p/web build` exit 0 でフロントエンドのビルド健全性を確認する。

---

## 6. 完了判定

このスプリントが終わったと言える条件:

1. **全 12 タスク (T-01-01 〜 T-01-12) が `/iterate` で `## DONE` まで到達** し、code-reviewer の `## APPROVED` と e2e-tester の `## DONE` を受領済み
2. ローカルで `pnpm install && pnpm db:seed && pnpm --filter @a2p/web dev && pnpm --filter @a2p/worker dev` が起動し、`/login` → ログイン → S-002 が表示
3. Vitest 全件 PASS（Playwright スモークは §5.2 のとおり SP-09 に繰越）
4. ローカル `apps/web` の `/api/health` が `{ ok: true, db: 'ok' }` を返す（Railway 実デプロイは SP-09 で確認）
5. `.env.example` と `packages/contracts/env.ts` のキー集合が完全一致（CI ジョブで保証）
6. `docs/03 §10 申し送り 3,7` と `docs/05 §13 申し送り 1,2,3,7,8,9,10` が実装に反映済み
7. **完了確認**: 本スプリント完了時に pm を `MODE: REVIEW TARGET: SP-01` で再起動し、`## PHASE_COMPLETE` が返ること
