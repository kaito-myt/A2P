# 03. 技術選定

> 本ドキュメントは `tech-selection` ハーネスエージェントが生成・更新する。
> 起点: `CLAUDE.md` "Tech stack (decided)"（確定事項、覆さない）、`docs/01-business-requirements.md`、`docs/02-functional-requirements.md`（F-001〜F-050）
> 後続: `docs/04-ui-design.md`, `docs/05-program-design.md` が本ドキュメントの選定を参照する。

---

## 1. 選定方針

A2P は **1 名運営の副業ツール** であり、月 100 冊 / 売上 15 万円 / コスト 5 万円というタイトな KPI を満たす必要がある。技術選定の優先順位は下記の通り。

| 優先順位 | 判断軸 | 説明 |
|---|---|---|
| 1 | **確定事項との整合** | CLAUDE.md `Tech stack (decided)` を最優先。覆す提案はしない |
| 2 | **運用負荷の低さ** | 1 名運営なので「常駐監視ゼロ・障害時の復旧手順がシンプル」を最重視 |
| 3 | **コスト** | 月 5 万円上限。インフラ + メール + 監視で 7,000 円以内、残りを LLM/画像生成に振る |
| 4 | **型安全 (TypeScript)** | エージェント I/O・ジョブペイロード・DB スキーマ全てを型で固める。`packages/contracts` を中心線とする |
| 5 | **プロバイダ非依存性** | F-022/F-023 マルチプロバイダ要件。Anthropic/OpenAI/Gemini の差し替えを 1 行で完結させたい |
| 6 | **将来の置き換え容易性** | Phase 4 や SaaS 化を視野に「コアを変えずに外側を交換できる」設計を志向 |

不確実な選定は明示的に **「Phase 2 で再評価」「コスト次第で見直し」** と注記する。

---

## 2. 確定スタック（CLAUDE.md より、理由肉付け）

| # | 領域 | 採用 | 採用理由（肉付け） | 競合 | リスク・回避策 |
|---|---|---|---|---|---|
| C-01 | フレームワーク | **Next.js 15 (App Router) + TypeScript** | Server Actions による軽量 API・streaming UI・shadcn 親和性・Vercel/Railway いずれでも動作。F-017〜F-021 のバルク操作 UI は SA + RSC が最短。F-023 のモデル切替プレビューも streaming で素直 | Remix / SvelteKit / Astro | App Router の癖 → `app/(routes)` 命名規約と `program-design` の API 設計で吸収 |
| C-02 | ホスティング | **Railway** (Web + Worker + Postgres) | 1 プロジェクトに Web/Worker/DB を同居でき、`pnpm` モノレポを 1 リポジトリで複数サービスにデプロイ可能。Postgres マネージドが安く、graphile-worker と同居しやすい | Render / Fly.io / Vercel + Supabase | Railway の障害時に全停止するリスク → 月次バックアップを R2 へ別途取得 (`pg_dump` の cron ジョブ) |
| C-03 | DB | **PostgreSQL + Prisma** | スキーマ多数（22 テーブル超）・JSON 列を多用 (`payload_json`, `score_breakdown_json`)・トランザクション必要。Prisma の型自動生成が `packages/contracts` と整合 | Drizzle / Kysely / TypeORM | Prisma マイグレーションの本番運用 → `prisma migrate deploy` を Railway のリリースフックで実行 |
| C-04 | ジョブキュー | **graphile-worker** | Postgres と同居でき Redis 不要 → コスト圧縮。cron 内蔵 (F-024 日次バッチに有用)。並列度・優先度・リトライ機構を備える | BullMQ (要 Redis) / Inngest (外部 SaaS) / Trigger.dev | 並列度 > 50 になるとボトルネック化 → 並列 5（書籍）×4（章）= 20 のため当面問題なし。Phase 4 で逼迫したら BullMQ 移行を検討（§7） |
| C-05 | AI オーケストレーション | **Anthropic Messages API クライアント (`@anthropic-ai/sdk`)** + Vercel AI SDK（役割別に使い分け） | Anthropic 公式 Messages API クライアント。`web_search_20250305` server tool を**そのままパラメータで指定して呼び出せる唯一のパス**であり、Marketer (F-001) の Web 検索要件と完全に整合。純 Node プロセスで動作するため Railway デプロイで追加バイナリ・追加認証は不要。Writer/Editor 等は §3 A の `AISdkClient` (Vercel AI SDK) 経由で複数プロバイダ抽象に乗せる二層構造（§3 A-01〜A-02 参照） | OpenAI Agents SDK / 自前 HTTP ループ / `@anthropic-ai/claude-agent-sdk` | **`@anthropic-ai/claude-agent-sdk` は不採用**：当初候補として検討したが、SP-02 T-02-03 実装中に「Claude Code CLI (`claude` バイナリ) をプログラマブルに子プロセス spawn するラッパ」であることが判明。`tools` 識別子も CLI 組込 (`WebSearch` 等) で Messages API の `web_search_20250305` と一致せず、Railway 本番でも `claude` CLI 同梱＋認証セットアップが必須となり Phase 1 MVP スコープを大きく逸脱するため撤回。Messages API クライアントへの移行で要件を満たす |
| C-06 | Web Search | **Anthropic `web_search_20250305` server tool**（`@anthropic-ai/sdk` 経由で `tools` パラメータに指定） | Marketer (F-001) が Amazon ランキング・競合レビューを取得。Anthropic 側で実行されるため追加インフラ不要。`AgentSdkClient` (= Messages API クライアントのラッパ) が `tools: [{ type: "web_search_20250305", name: "web_search", max_uses: N }]` を組み立て、ツール実行結果 (`web_search_tool_result`) と引用 (`citations`) を含むレスポンスを取得して整形する | Brave Search / Tavily / SerpAPI | Anthropic モデル限定 → F-023 で Marketer を Gemini に切り替えた場合は Tavily 経由のフォールバックを `packages/agents/tools/web-search.ts` に実装（§3 A-03） |
| C-07 | 画像生成 | **OpenAI `gpt-image-1`** | F-007 カバー生成。日本語タイポ含む高品質画像、KDP 推奨寸法 2560×1600 を直接生成可能 | Stable Diffusion 系 / Midjourney / Imagen 3 | 単価変動 → F-024 カタログ取得対象に含める。Sharp で後処理リサイズ（F-014） |
| C-08 | Word 出力 | **`docx`** (npm) | F-012。ピュア JS で動作し Railway 上で素直に動く。Heading1 スタイル・目次自動生成可能 | docx-templater / officegen | テンプレート機能は弱い → `packages/output/word/` にビルダ層を実装してカプセル化 |
| C-09 | PDF 出力 | **`@react-pdf/renderer`** | F-013。React コンポーネントで構築でき shadcn のスタイル流用が利く | Puppeteer / pdfkit / pdf-lib | 5 万字本文の組版性能懸念 → Phase 1 で実測。問題があれば **Puppeteer + Markdown→HTML レンダラへフォールバック**（§3 E に代替記述） |
| C-10 | オブジェクトストレージ | **Cloudflare R2** | F-015。エグレス無料 → 大量 PDF/PNG ダウンロード時のコストを抑える。S3 互換 API なので `@aws-sdk/client-s3` で操作可能 | AWS S3 / Backblaze B2 / Supabase Storage | API 互換の取りこぼし → `@aws-sdk/client-s3 + S3 互換 endpoint` 構成で十分実績あり |
| C-11 | 認証 | **NextAuth Credentials provider** | F-043 シングルユーザー、env 配布パスワード。OAuth 不要 | Lucia / Clerk / Auth.js v5（NextAuth と同系列） | NextAuth v5 (Auth.js) のリリース状況に追従。本選定では **`next-auth ^5` (Auth.js)** を採用 |
| C-12 | UI ライブラリ | **Tailwind + shadcn/ui** + **カスタムデザイントークン (Lovable 風 "warm parchment / charcoal" テーマ)** | F-021/F-035/F-039 などダッシュボード/テーブル多数。shadcn の Data Table / Dialog / Tabs を直接活用。デフォルトテーマは使わず、`docs/04 §6.3` のトークン (cream/charcoal/border-warm/opacity スケール、radius スケール、L2 Inset / L3 Focus シャドウ) で全面上書き | Mantine / Chakra / MUI | デフォルトの shadcn テーマと差が大きいため、`packages/ui/tokens.ts` でトークン集約 + `tailwind.config.ts` の `theme.extend` でハードコード。詳細は §3 UI-01〜UI-04 |
| C-13 | テスト (単体) | **Vitest** | Vite ベースの ESM 対応・速い・Jest 互換 API。Prisma モック / Agent SDK モックと相性良好 | Jest | Edge ランタイムでのテストは未検証 → `apps/web` の SA は Node ランタイムで統一 |
| C-14 | テスト (E2E) | **Playwright** | F-041 (KDP 自動入稿) で Playwright を Worker 内で使うため、E2E テストも同一フレームに揃え学習コストを削減 | Cypress | Playwright のヘッドフル/ヘッドレス切替 → E2E は headless、F-041 本番運用も headless（§3 C 参照） |

---

## 3. 追加選定（未決領域）

CLAUDE.md に書かれていないが機能要件から導出される 10 領域 (A〜J) を新規に選定する。各行は **対応機能 ID** を明示。

### A. マルチプロバイダ抽象化（F-022 / F-023）

複数プロバイダを役割×ジャンルで切り替える要件。Claude Agent SDK が Anthropic 専用機能（subagent / web_search server tool）を持つため、**Agent SDK と AI 抽象層を二層にする** 方針を採用する。

| # | 領域 | 採用 | 対応機能 | 採用理由 | 競合 | リスク・回避策 |
|---|---|---|---|---|---|---|
| A-01 | LLM プロバイダ抽象 | **Vercel AI SDK (`ai` ^5)** + `@ai-sdk/anthropic` / `@ai-sdk/openai` / `@ai-sdk/google` | F-022, F-023, F-026, F-031, F-050 | 25+ provider 統一インターフェース、streaming/tool-calling/structured-output が type-safe、bundle size 25 kB と軽量、`usage` フィールドで入出力トークン数を統一取得（F-032 と直結） | LangChain.js / 独自薄ラッパ / NeuroLink | Anthropic 固有機能（web_search server tool）は Agent SDK 経由で実行 → 二層構造（Marketer 役のみ Agent SDK、その他 4 役は AI SDK 経由） |
| A-02 | Anthropic ネイティブ層 (`AgentSdkClient`) | **`@anthropic-ai/sdk` ^0.x (Anthropic 公式 Messages API クライアント)** | F-001, F-009 | Marketer の `web_search_20250305` server tool 利用と Prompt Optimizer の長文プロンプト分析を、**Messages API + server tools** の組み合わせで実現。`messages.create({ tools: [{ type: "web_search_20250305", ... }], ... })` を直接呼び、`web_search_tool_result` / `citations` を含むレスポンスを構造化して返す。`AgentSdkClient` は `LLMClient` interface (`complete()` / `stream()`) を実装し、`AISdkClient` (A-01) と入出力契約を統一。`getApiKey('anthropic')` ヘルパ (T-02-13 で確立) で DB `api_credentials` 優先 + `ANTHROPIC_API_KEY` フォールバックの取得規約に従う。純 Node プロセスで動作し Railway デプロイは追加バイナリ不要 | `@anthropic-ai/claude-agent-sdk` (Claude Code CLI ラッパ) / OpenAI Agents SDK / 自前 fetch 実装 | **代替案 `@anthropic-ai/claude-agent-sdk` を考慮したが不採用**：実装上は `claude` CLI バイナリを子プロセス spawn する方式で、Railway 本番に CLI バイナリ同梱＋ Claude 認証セットアップが必要となる。さらに `tools` 識別子が CLI 組込 (`WebSearch` 等) で Messages API の `web_search_20250305` と一致しないため、Marketer の Web 検索要件と整合しない（SP-02 T-02-03 実装中に判明し撤回）。Anthropic 以外モデル切替時は AI SDK 側 (A-01) にフォールバックし、Web 検索は **Tavily API** で代替（A-03） |
| A-03 | Web 検索フォールバック | **Tavily API** (`@tavily/core`) | F-001（Anthropic 以外モデル選択時） | Anthropic web_search server tool が使えない場合に Marketer から呼べる軽量 Web 検索。$0.008/req 程度、月 1,000 リクエストでも $8 | Brave Search / SerpAPI | Phase 1 では Anthropic Marketer で動作するため必須ではない。Phase 2 で Gemini Marketer を試す場合に有効化 |
| A-04 | エラー/リトライポリシー | **`p-retry` ^7** + 自前のプロバイダ別エラー判定 | F-016, F-050 | 指数バックオフ標準実装。AI SDK の `generateText` をラップしてリトライ。RateLimit 429 は最大 3 回、その他 5xx は 1 回 | exponential-backoff / async-retry | プロバイダ別エラーコードを `packages/agents/lib/errors.ts` に集約 |

**設計指針**:

- `packages/agents/lib/llm-client.ts` に **統一インターフェース** を定義：

```typescript
interface LLMClient {
  complete(args: { messages, model, role, bookId, ... }): Promise<{ text, usage, cost }>
  stream(args): AsyncIterable<...>
}
```

- 実装は 2 つ（**二層構造を維持**）：
  - **`AISdkClient`**（Vercel AI SDK `ai` ^5 + `@ai-sdk/{anthropic,openai,google}` ^2 ベース、全プロバイダ汎用）：Writer / Editor / Quality Judge / Thumbnail / その他多役。T-02-02 で実装済。
  - **`AgentSdkClient`**（`@anthropic-ai/sdk` ^0.x、Anthropic Messages API を直接利用）：Marketer (F-001) のみ。`web_search_20250305` server tool を `messages.create({ tools: [...] })` で組み立てて呼び出すために存在。Prompt Optimizer (F-009) の長文分析でも将来利用予定。SP-02 T-02-03 で実装。
- `model_assignments` テーブル（F-022）の `provider`/`model` と `role` を見て、**`role=marketer` かつ `provider=anthropic`** の場合のみ `AgentSdkClient` を、それ以外は全て `AISdkClient` を選択するファクトリを `packages/agents/lib/llm-client/factory.ts` に置く。
- 両クライアントは `getApiKey(provider)` ヘルパ (T-02-13) 経由で API キーを取得し、DB `api_credentials` 設定を優先・env 変数をフォールバックとする統一規約に従う。
- 全 LLM 呼び出しは `withTokenLogging()` ミドルウェアでラップし、`token_usage` に自動 INSERT（F-032 を漏れなく実装）。`AgentSdkClient` は Messages API の `response.usage` を、`AISdkClient` は AI SDK の `result.usage` を、それぞれ同一の `{ inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }` 形に正規化する。

### B. モデル単価カタログ自動取得（F-024）

公式 API の有無を整理：

- **Anthropic**: 公式の「モデル一覧 API」あり (`GET /v1/models`)。ただし**単価は API では取得できない** → 公式 pricing ページの HTML スクレイピング or 手動更新が必要
- **OpenAI**: 公式の `GET /v1/models` あり、単価は同じく API 化されていない → ページスクレイピング
- **Google Gemini**: `GET /v1beta/models` あり、単価非提供
- **共通**: 単価は公式ページから取得 + 失敗時は **手動更新 UI** にフォールバック

| # | 領域 | 採用 | 対応機能 | 採用理由 | 競合 | リスク・回避策 |
|---|---|---|---|---|---|---|
| B-01 | モデル一覧取得 | 各プロバイダ公式 SDK の `models.list()` | F-024 | API ベースなので安定。Anthropic/OpenAI/Google 各 SDK 経由 | 各社 REST 直叩き | プロバイダ側の SDK バージョン追従が必要 → renovate で自動 PR |
| B-02 | 単価スクレイピング | **`cheerio` ^1** + 各プロバイダ pricing ページ | F-024 | DOM パースで価格セルを抽出。Playwright より軽量・速い | Playwright headful 取得 | ページ構造変更で破綻 → **取得失敗時は前日値を継続使用 + 運営者通知 (F-024 受入基準)** |
| B-03 | 手動更新フォールバック UI | `app/admin/model-catalog/` 内に編集フォーム | F-024, F-025 | スクレイピング失敗時に運営者が `model_catalog` を手動編集できる窓口 | — | 手動編集は `audit_log` に記録（誰がいつ変更したか追跡） |
| B-04 | 為替レート取得 | **exchangerate.host (無料 API)** または **`open.er-api.com`** | F-024 (USD→JPY 換算) | 無料・APIキー不要。USD/JPY を日次取得し `model_catalog.fx_rate_snapshot` に保存 | Fixer.io（無料は月 100req）/ Wise API（要審査） | 無料 API の停止リスク → 取得失敗時は前日レート継続使用。年に 1 度マニュアル切替前提 |
| B-05 | 単価変動アラート | 自前ロジック (graphile-worker cron 内) | F-024 受入基準 | 前日比 ±10% 変動でメール通知 (D-01 経由) | — | 仕様に追加実装する程度で十分 |

### C. KDP 自動入稿 (Phase 3) — F-041

| # | 領域 | 採用 | 対応機能 | 採用理由 | 競合 | リスク・回避策 |
|---|---|---|---|---|---|---|
| KDP-01 | ブラウザ自動化 | **Playwright (`@playwright/test` ^1.50)** | F-041, F-042, F-038 | E2E (H-02) と統一。Chromium ヘッドレスで KDP 操作可能 | Puppeteer / Selenium | KDP の Bot 検出 → **stealth プラグイン (`playwright-extra` + `puppeteer-extra-plugin-stealth`)** を併用 |
| KDP-02 | 実行モード | **headless** (Railway 上) | F-041 | Railway のサーバ環境では headful 表示先がない。Bot 検出は stealth プラグインで対処 | headful + Xvfb | stealth で突破できない場合は **専用 worker をローカル PC で常駐** に切替（Phase 3 設計時に再評価） |
| KDP-03 | 2FA 通知 | Push-and-wait: **メール送信 (D-01)** + **承認用ワンタイム URL** | F-041 受入基準 | 運営者本人へメール → 受信メール内の URL を踏むと `kdp_2fa_codes.code` を入力する画面が開く。Worker は DB をポーリングして待機 | Slack/Discord Webhook / SMS | メール到達遅延（数十秒〜数分）→ 最長 10 分のタイムアウトを受入基準に明記済み |
| KDP-04 | KDP 認証情報暗号化 | **Node.js `crypto` (AES-256-GCM)** | F-044 受入基準 | 標準ライブラリで十分。鍵は env `KDP_CRED_KEY`（32 bytes hex） | `@aws-crypto/client-node` / libsodium | 鍵紛失リスク → 鍵を Railway env と運営者ローカル `.env.local` の 2 箇所に同期保管 |
| KDP-05 | ブラウザバイナリの永続化 | Dockerfile で `npx playwright install --with-deps chromium` | F-041 | Railway のビルドキャッシュに乗せて起動時 DL を回避 | — | Chromium のバージョン更新は monthly で renovate 検出 |

### D. メール通知 — F-034, F-036, F-024, F-041, F-049, F-050

| # | 領域 | 採用 | 対応機能 | 採用理由 | 競合 | リスク・回避策 |
|---|---|---|---|---|---|---|
| D-01 | メール送信 | **Resend (`resend` ^4)** | F-034, F-036, F-024, F-041, F-050 完了通知 | 月 3,000 通まで無料 (free tier)、$20/month で 50,000 通。Railway との接続実績豊富、APIキー方式でセットアップ最短、HTML テンプレ `react-email` が公式統合 | SendGrid / Postmark / AWS SES | 無料枠超過リスク → 1 通/書籍想定で月 100 冊 × 数通 = 数百通、無料枠で完結 |
| D-02 | メールテンプレ | **`react-email` (`@react-email/components` ^0.0)** | 同上 | React コンポーネントでメール作成、Resend と相性最良 | mjml / handlebars | テンプレ数が少ない (5 種程度) ため学習コストは低い |

### E. PDF/Word/PNG 出力（C-08, C-09 の補強と画像後処理）

| # | 領域 | 採用 | 対応機能 | 採用理由 | 競合 | リスク・回避策 |
|---|---|---|---|---|---|---|
| E-01 | Word 出力 | **`docx` ^9** | F-012 | C-08 で確定済み。章 = Heading1、目次は `TableOfContents` API で自動生成 | — | — |
| E-02 | PDF 出力 (一次) | **`@react-pdf/renderer` ^4** | F-013 | C-09 で確定済み。React コンポーネントで段組み・章扉対応 | — | 5 万字 × 7-10 章で 200 ページ超 → メモリ使用量を Phase 1 で計測 |
| E-03 | PDF 出力 (フォールバック) | **Puppeteer + Markdown→HTML→PDF** | F-013 (代替) | `@react-pdf/renderer` が長文で性能不足の場合に切替。Marked + Tailwind CSS で素直にレイアウト可能 | — | 採用判断は Phase 1 計測結果次第。**現時点では未採用**。`docs/05` で評価結果を反映 |
| E-04 | 画像リサイズ | **`sharp` ^0.34** | F-014 | gpt-image-1 出力 (1024×1024 or 1536×1024) を KDP 推奨 2560×1600 に bicubic アップスケール、ICC プロファイル設定 | jimp / imagemagick CLI | Sharp は libvips ネイティブ → Railway の Linux 環境で問題なし、Dockerfile に `apt-get install libvips-dev` を含める |
| E-05 | 日本語フォント埋め込み | **Noto Sans JP / Noto Serif JP (Google Fonts)** をリポジトリ同梱 | F-012, F-013 | KDP の縦書き需要は当面なし。横書き和文は Noto で十分 | — | フォントファイルサイズ (約 5 MB) → `apps/worker` のみに同梱、`apps/web` には含めない |

### F. ジョブキュー周辺（C-04 の運用詳細） — F-010, F-011, F-016, F-050

| # | 領域 | 採用 | 対応機能 | 採用理由 | 競合 | リスク・回避策 |
|---|---|---|---|---|---|---|
| JQ-01 | 書籍並列度 | **graphile-worker `concurrency: 5`**（環境変数で可変） | F-011 | KPI: 1 晩 3〜5 冊。並列度 5 で運用 | — | 並列度 > 5 にすると DB 負荷増 → `pg_stat_activity` を監視 |
| JQ-02 | 章並列度 | 書籍ジョブ内で **Promise.all + p-limit (`concurrency: 4`)** | F-004, F-011 | 1 冊 7-10 章を 4 並列で執筆 | — | LLM API のレートリミット衝突 → AI SDK + p-retry で自動リトライ |
| JQ-03 | 優先度キュー | **graphile-worker `task_identifier` ベースの分離 + `priority` カラム** | F-050（修正コメント実行は高優先度） | 通常パイプライン (priority=10) と修正実行 (priority=1) を分離 | — | — |
| JQ-04 | リトライポリシー | 各タスクで `max_attempts=3` + 指数バックオフ（5/30/180 秒） | F-016 受入基準 | LLM 一時障害を吸収 | — | 4 回目以降は人手介入（F-046） |
| JQ-05 | タイムアウト | タスク種別ごとに設定: Writer 章 30 分 / Editor 全体 20 分 / Image gen 5 分 / KDP 入稿 30 分 | F-011, F-041 | LLM 長時間応答を想定 | — | タイムアウト後は `jobs.status = failed`、F-016 で再開可能 |
| JQ-06 | cron スケジュール | graphile-worker 内蔵 `crontab` 機能 | F-024 (日次)、F-021 (バッチ計画起動) | 別途 cron サービス不要 | node-cron | DST 影響なし（日本のみ運用） |
| JQ-07 | 重複起動防止 | `revision_runs.book_ids_json` を一意制約風に `UNIQUE` パーシャル index で防止 | F-050 受入基準 | 同じ書籍の修正ジョブが多重起動しないように | — | 実装は `program-design` で詳細化 |

### G. オブザーバビリティ・ロギング

| # | 領域 | 採用 | 対応機能 | 採用理由 | 競合 | リスク・回避策 |
|---|---|---|---|---|---|---|
| G-01 | 構造化ロギング | **`pino` ^9** + `pino-pretty` (dev) | F-045 | 高速・軽量・JSON 出力、Railway logs にそのまま流す。next-logger で Next.js 統合 | winston / bunyan | ログレベル統制を `packages/contracts/logger.ts` で集約 |
| G-02 | エラートラッキング | **Sentry (`@sentry/nextjs` + `@sentry/node`)** | F-016, F-041, F-050 | 無料枠 5,000 events/month で個人運用に十分。Next.js / Node Worker 両対応 | Highlight / Bugsnag / なし | コスト超過時は free tier に留めるため `sampleRate: 0.5` 等で調整 |
| G-03 | メトリクス | **アプリ内 DB 集計**（`token_usage` / `jobs` テーブル）+ ダッシュボード SQL | F-033, F-035, F-039 | Prometheus/OTel は個人運用で重い。DB 集計で十分 | OpenTelemetry / Grafana Cloud | 集計クエリの遅延 → `program-design` で適切なインデックス設計 |
| G-04 | ヘルスチェック | Next.js `/api/health` ＋ Worker は graphile-worker の組込 health | 運用全般 | Railway の healthcheck と統合 | — | — |

### H. テスト環境

| # | 領域 | 採用 | 対応機能 | 採用理由 | 競合 | リスク・回避策 |
|---|---|---|---|---|---|---|
| H-01 | Unit テスト | **Vitest ^2** | 全機能 | C-13 確定 | — | — |
| H-02 | E2E テスト | **Playwright ^1.50** | 全 UC、特に UC-01〜UC-06 | C-14 確定 | — | — |
| H-03 | LLM モック | **`msw` (Mock Service Worker) ^2** で HTTP レベル interception | 単体テスト全般 | Anthropic/OpenAI/Gemini を HTTP レベルで一様にモック可能、`packages/agents` テストの再現性が高い | nock / 手書きスタブ | streaming response のモックは複雑 → `msw` のストリーミングサポートを利用 |
| H-04 | フィクスチャ DB | **Testcontainers (`@testcontainers/postgresql`)** | DB 関連テスト | 各テストランで一時 Postgres を起動、本番と同一バージョン (PG 16) で再現性高 | sqlite モック / 共有 DB | Docker daemon 必要 → CI と開発端末で必須。Windows でも Docker Desktop で動作 |
| H-05 | E2E CI 実行環境 | **GitHub Actions** (`ubuntu-latest` ＋ Playwright Docker image) | 全 UC | Railway 上で E2E を回すと本番ジョブと衝突 → GitHub Actions で分離。無料枠 2,000 分/月で十分 | Railway 上で実行 / CircleCI | 課金は無料枠内、超過時のみ判断 |

### I. CI/CD

| # | 領域 | 採用 | 対応機能 | 採用理由 | 競合 | リスク・回避策 |
|---|---|---|---|---|---|---|
| I-01 | CI | **GitHub Actions** | 全コード変更 | 無料枠 2,000 分/月。lint / typecheck / vitest / playwright e2e の 4 ジョブ並列 | Railway built-in CI / CircleCI | — |
| I-02 | CD (Web/Worker) | **Railway の Git 自動デプロイ**（main ブランチ push でデプロイ） | 全機能 | GitHub 連携が標準機能、Pull Request preview 環境も自動生成可 | Render / fly.io / 手動 | デプロイ事故 → main 前に `staging` ブランチで 1 段検証する運用、リリースは PR ベース |
| I-03 | DB マイグレーション | **`prisma migrate deploy`** を Railway リリースフックで実行 | スキーマ変更全般 | Railway の "Pre-deploy command" 機能で実行可能 | sqitch / 手動 | マイグレーション失敗時は Railway デプロイがロールバック |
| I-04 | バージョン管理 | **pnpm workspace + changeset** (将来) | パッケージ管理 | モノレポ内パッケージ管理。Phase 1 は internal package のみなので changeset は不要、Phase 2 で評価 | yarn workspace / npm workspace | Phase 1 では pnpm workspace のみ |

### J. シークレット管理

| # | 領域 | 採用 | 対応機能 | 採用理由 | 競合 | リスク・回避策 |
|---|---|---|---|---|---|---|
| J-01 | env 管理 | **`.env.local` (開発) + Railway Variables (本番)** | 全認証情報 | CLAUDE.md 確定。Hard Rule 6 で `.env.*` は git 管理外 | Doppler / 1Password CLI / Infisical | 同期手段なし → **`packages/contracts/env.ts` で zod スキーマ定義** し、起動時に必須 env を検証 |
| J-02 | env 検証 | **`zod` ^3** ベースの起動時バリデーション | 全機能 | 環境変数の型安全＋起動時失敗で本番事故を防ぐ | t3-env | t3-env は zod の薄ラッパで Next.js 統合が秀逸 → Phase 1 で `@t3-oss/env-nextjs` 採用を再評価 |
| J-03 | env テンプレート | **`.env.example`** をリポジトリ同梱 | 開発オンボーディング | 環境変数一覧（§5）と完全一致させる | — | CI で `.env.example` と zod スキーマの差分検出ジョブを追加 |

### K. UI デザイントークン・フォント（`docs/04 §6.3` の実装基盤）

`docs/04 §6.3` で定義した Lovable 風 "warm parchment / charcoal" デザイントークンを **コードの正本** として実装する技術スタック。`packages/ui/` に集約し、`apps/web` から import する。

| # | 領域 | 採用 | 対応機能 | 採用理由 | 競合 | リスク・回避策 |
|---|---|---|---|---|---|---|
| UI-01 | デザイントークン管理 | **`packages/ui/tokens.ts` (TypeScript export) + `tailwind.config.ts` の `theme.extend`** | 全 UI 機能 | トークン値（色・余白・radius・shadow）を TS で 1 箇所に定義し、Tailwind と React コンポーネントの両方から型安全に参照。`docs/04 §6.3` の表をそのままコード化 | CSS 変数のみ / Style Dictionary / Tokens Studio | Tokens Studio などのツールは個人開発で過剰 → ts ファイル直管理で十分。将来 Figma 連携が必要になったら Style Dictionary 経由でエクスポート可能 |
| UI-02 | 英数字フォント | **`Inter` (Variable, Google Fonts)** via `next/font/google` | 全 UI | Camera Plain Variable は商用ライセンス問題で採用不可。Inter は humanist warmth を持ち Camera Plain に最も近い無料代替。Variable Font で weight 400/480/600 を 1 ファイルで配信できる。`next/font` で SSR セルフホスト、CLS 回避 | IBM Plex Sans / Manrope / Söhne（有料） | 日本語混植時のベースライン揃え → §6.7 で `font-feature-settings: "palt"` を日本語要素にだけ適用する CSS を `apps/web/app/globals.css` に書く |
| UI-03 | 日本語フォント | **`Noto Sans JP` (Variable, Google Fonts)** via `next/font/google` | 全 UI（日本語ファースト） | Inter との視覚的相性が高く、weight 400/500/600 が同一ファイルから取得可能。日本語ファースト UI（CLAUDE.md Hard Rule 2）に必須 | 游ゴシック / Hiragino Sans / IBM Plex Sans JP | Variable Font は通常 ~600 KB と重い → `display: 'swap'` で初期表示は system-ui fallback、`subsets: ['latin']` 指定で英字部分は Inter に任せる |
| UI-04 | shadcn/ui テーマ上書き | **`components.json` の cssVariables=true + `globals.css` の `:root` で CSS Variables を §6.3 値に差し替え** | 全 shadcn コンポーネント | shadcn は CSS Variables ベースの semantic token（`--background`, `--primary`, `--border`, ...）を採用。これらを §6.3 の cream/charcoal/border-warm 値に差し替えることで、shadcn の Button/Card/Input/Dialog 等が自動的に warm parchment テーマに従う | Mantine / Chakra の theme provider 方式 | CSS Variables はランタイム切替不可だが、A2P はライトテーマ固定 (CLAUDE.md 単独運用) なので問題なし。dark mode は Phase 4 以降の検討事項とし、Open Questions に追加 |

**実装の正本構成**:

```
packages/ui/
  tokens.ts                    ← §6.3 全トークン (色/余白/radius/shadow/type) を export
  fonts.ts                     ← next/font/google の Inter + Noto Sans JP 設定
  components/                  ← shadcn/ui の生成済みコンポーネント (theme 上書き済)
  index.ts
apps/web/
  app/
    globals.css                ← :root に CSS Variables (§6.3 値) + @font-face は使わず next/font
    layout.tsx                 ← <html className={inter.variable + ' ' + notoJp.variable}>
  tailwind.config.ts           ← theme.extend で packages/ui/tokens.ts を import して展開
  components.json              ← shadcn 設定 (cssVariables: true, baseColor: "neutral")
```

**ジャンル別の例外なし**: `docs/04 §6.5 Do/Don't` を全 UI タスクで遵守する。`programmer` エージェントは shadcn の `npx shadcn add` でコンポーネント生成後、必ず `packages/ui/components/` に移動して theme 上書きを確認する。

---

## 4. 依存バージョン方針

LTS / latest stable を基本とし、Phase 0-1 では新規プロジェクトの利点を最大化する。

| パッケージ / ランタイム | バージョン目標 | 備考 |
|---|---|---|
| Node.js | `^22 LTS` | Railway の標準サポート。Active LTS（〜2027 年 4 月）。`engines.node` で固定 |
| pnpm | `^9` | workspace 機能成熟。Corepack で固定 |
| TypeScript | `^5.6` | satisfies / const type parameter / decorators stable |
| Next.js | `^15.0` | App Router 安定版、React 19 対応、Server Actions 標準 |
| React | `^19.0` | Next.js 15 と整合 |
| Prisma | `^6` | PG 16 対応、Driver Adapters による軽量化 |
| graphile-worker | `^0.16` | PG 16 対応 |
| PostgreSQL | `^16` | Railway 最新マネージド |
| `ai` (Vercel AI SDK) | `^5` | provider モジュール `@ai-sdk/anthropic` `@ai-sdk/openai` `@ai-sdk/google` も `^2` で同期。`AISdkClient` (T-02-02) で利用 |
| `@anthropic-ai/sdk` | `^0.x` (latest) | Anthropic 公式 Messages API クライアント。`AgentSdkClient` (T-02-03) で Marketer の `web_search_20250305` server tool 呼び出しに利用。**当初候補だった `@anthropic-ai/claude-agent-sdk` (Claude Code CLI ラッパ) は不採用** — §2 C-05 / §3 A-02 参照 |
| `openai` (公式 SDK) | `^4` | Vercel AI SDK 内部で利用、直接呼出は最小限 |
| `@google/generative-ai` | `^0.x` (latest) | Vercel AI SDK 経由がメイン |
| `next-auth` (Auth.js) | `^5` | Credentials provider |
| `tailwindcss` | `^4` | v4 stable、Lightning CSS ベース |
| `shadcn/ui` | (CLI 最新) | バージョンレス、CLI で生成 |
| `docx` | `^9` | F-012 |
| `@react-pdf/renderer` | `^4` | F-013 |
| `sharp` | `^0.34` | F-014 |
| `@aws-sdk/client-s3` | `^3` | R2 用 |
| `resend` | `^4` | D-01 |
| `react-email` | `^3` | D-02 |
| `@playwright/test` | `^1.50` | E2E + KDP 自動入稿共通 |
| `vitest` | `^2` | unit test |
| `pino` | `^9` | logger |
| `@sentry/nextjs` / `@sentry/node` | `^8` | error tracking |
| `zod` | `^3` | env / contracts |
| `p-retry` | `^7` | retry |
| `p-limit` | `^6` | 章並列度制御 |
| `cheerio` | `^1` | 単価スクレイピング |
| `msw` | `^2` | test mocking |
| `@testcontainers/postgresql` | `^10` | DB テスト |
| `next/font` (組み込み) | (Next.js 同梱) | Inter + Noto Sans JP セルフホスト (UI-02, UI-03) |
| `@tailwindcss/typography` | `^0.5` | 章本文プレビューの Markdown レンダリング |
| `class-variance-authority` | `^0.7` | shadcn 標準依存。バリアント定義 |
| `clsx` / `tailwind-merge` | `^2` / `^2` | shadcn 標準依存。className 合成 |

---

## 5. 環境変数一覧（暫定）

`.env.example` への転記前提。Railway Variables にも同名で登録する。

| 変数名 | 用途 | 必須/任意 | 例 / 形式 |
|---|---|---|---|
| `NODE_ENV` | 実行モード | 必須 | `development` / `production` |
| `DATABASE_URL` | Postgres 接続文字列 | 必須 | `postgresql://user:pass@host:5432/db` |
| `NEXTAUTH_SECRET` | NextAuth セッション署名鍵 | 必須 | 32 bytes hex |
| `NEXTAUTH_URL` | NextAuth コールバック URL | 本番のみ必須 | `https://a2p.example.com` |
| `NEXT_PUBLIC_APP_URL` | アプリ公開 URL（Resend メール本文リンク生成、Phase 3 KDP 2FA push-and-wait の承認 URL、フロント参照可能な唯一の URL 変数） | 必須 | `https://a2p.example.com` |
| `AUTH_USERNAME` | シングルユーザー名 | 必須 | `operator` |
| `AUTH_PASSWORD_HASH` | bcrypt 互換ハッシュ済みパスワード（採用ライブラリ: bcryptjs。Railway glibc 互換性のためネイティブ bcrypt ではなく純 JS 実装を採用） | 必須 | `$2a$12$...` |
| `ANTHROPIC_API_KEY` | Claude API キー（**フォールバック専用**、DB `api_credentials` 設定優先 / F-051）。`AgentSdkClient` (`@anthropic-ai/sdk`, Messages API) および `AISdkClient` (`@ai-sdk/anthropic`) のいずれも `getApiKey('anthropic')` ヘルパ (T-02-13) 経由で取得 | 任意 (DB 未設定時は必須) | `sk-ant-...` |
| `OPENAI_API_KEY` | OpenAI API キー（gpt-image-1 + LLM、**フォールバック専用**）。`getApiKey('openai')` 経由 | 任意 (DB 未設定時は必須) | `sk-...` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Gemini API キー（**フォールバック専用**）。`getApiKey('google')` 経由 | 任意 (DB 未設定時は必須) | `AI...` |
| `TAVILY_API_KEY` | Web 検索フォールバック（**フォールバック専用**、Anthropic 以外モデルへ Marketer 切替時に使用） | 任意（Phase 2+） | `tvly-...` |
| `R2_ACCOUNT_ID` | Cloudflare R2 アカウント ID | 必須 | hex 文字列 |
| `R2_ACCESS_KEY_ID` | R2 アクセスキー | 必須 | — |
| `R2_SECRET_ACCESS_KEY` | R2 シークレット | 必須 | — |
| `R2_BUCKET_NAME` | バケット名 | 必須 | `a2p-artifacts` |
| `R2_PUBLIC_URL_BASE` | 署名付き URL のベース | 必須 | `https://<account>.r2.cloudflarestorage.com/<bucket>` |
| `RESEND_API_KEY` | メール送信 API キー | 必須 | `re_...` |
| `MAIL_FROM` | 送信元アドレス | 必須 | `a2p@example.com` |
| `MAIL_TO` | 通知送信先（運営者本人） | 必須 | `operator@example.com` |
| `KDP_CRED_KEY` | KDP 認証情報暗号化鍵 (AES-256-GCM) | Phase 3 必須 | 32 bytes hex |
| `SENTRY_DSN` | Sentry DSN | 任意 | `https://...@sentry.io/...` |
| `LOG_LEVEL` | pino ログレベル | 任意 | `info` / `debug` |
| `WORKER_BOOK_CONCURRENCY` | 書籍並列度 | 任意（既定 5） | `5` |
| `WORKER_CHAPTER_CONCURRENCY` | 章並列度 | 任意（既定 4） | `4` |
| `MODEL_CATALOG_FETCH_CRON` | 単価取得 cron | 任意（既定 `0 19 * * *` = JST 04:00） | crontab 式 |
| `FX_RATE_API_URL` | 為替 API エンドポイント | 任意 | `https://open.er-api.com/v6/latest/USD` |
| `COST_LIMIT_PER_BOOK_JPY` | 1 冊コスト上限 | 任意（既定 500） | `500` |
| `COST_LIMIT_MONTHLY_JPY` | 月次コスト上限 | 任意（既定 50000） | `50000` |

---

## 6. コスト試算（粗）

前提：月 100 冊出版 / 1 冊 5 万字 / AI 役割は §7.3 推奨配分 / 月額上限 5 万円。

### 6.1 LLM コスト試算

1 冊あたりの想定トークン消費（粗算）：

| 役割 | 想定モデル | 入力トークン | 出力トークン | 1 冊あたり JPY (※1) |
|---|---|---|---|---|
| Marketer (テーマ + メタデータ) | Claude Opus 4.7 | 8,000 | 4,000 | ~80 円 |
| Writer (本文 5 万字) | Claude Sonnet 4.6 | 30,000 | 80,000 | ~250 円 |
| Editor (校閲) | Claude Sonnet 4.6 | 60,000 | 50,000 | ~180 円 |
| Quality Judge (Phase 2) | Claude Sonnet 4.6 | 50,000 | 2,000 | ~30 円 |
| Thumbnail テキスト | Claude Sonnet 4.6 | 1,500 | 1,500 | ~5 円 |
| 合計 (Phase 2 込) | — | — | — | **~545 円** |

(※1) 1 USD = 157 JPY 想定。Sonnet $3/$15 per MTok、Opus $15/$75 per MTok ベースの目安。

→ 1 冊 500 円目標は **Quality Judge を Phase 1 後半までオプション化**、Writer の中間出力を圧縮する等の調整で達成可能ラインに位置。月 100 冊で **LLM 合計 4 万〜5 万円**（上限張り付き）。Prompt Optimizer は月数回起動なので別途数百円。

### 6.2 月額合計試算

| カテゴリ | サービス | 月額目安 (JPY) | 備考 |
|---|---|---|---|
| LLM | Claude (Opus + Sonnet) | 35,000〜45,000 円 | F-022/F-023 で運営者切替により圧縮余地 |
| 画像 | OpenAI gpt-image-1 | 3,000〜5,000 円 | 100 冊 × 3 候補 × $0.02 = $6 程度。色違い・帯違いも含めた余裕枠 |
| インフラ | Railway (Web + Worker + Postgres) | 3,000〜5,000 円 | Hobby $5/月 + 使用量、$20-30/月 = 約 3,000〜5,000 円 |
| ストレージ | Cloudflare R2 | 〜500 円 | ストレージ $0.015/GB、エグレス無料 |
| メール | Resend | 0 円 | 月 3,000 通の無料枠で完結 |
| 監視 | Sentry | 0 円 | free tier 5,000 events で十分 |
| Web 検索 | Tavily (Phase 2 以降) | 0〜1,000 円 | Phase 1 は Anthropic web_search 内包 |
| 為替バッファ | — | 500〜1,000 円 | USD 変動吸収用 |
| **合計** | — | **42,000〜57,500 円** | 上限 50,000 円に対し **やや張り付き**。Q4 の余裕は 0〜8,000 円 |

### 6.3 コスト最適化レバー

| レバー | 効果 | 採用判断 |
|---|---|---|
| Writer を Sonnet → Gemini 2.x Flash | 1 冊 80-150 円圧縮 | F-022/F-023 で運営者がいつでも切替可、UC-02 |
| Editor を Sonnet → Haiku | 1 冊 100 円圧縮、品質低下リスクあり | Phase 2 で A/B (F-026, F-031) で検証 |
| Quality Judge を Haiku | 1 冊 25 円圧縮 | Phase 2 開始時に検証 |
| Prompt Caching (Anthropic) | 入力トークン -50% (Writer の固定プロンプト部分) | Phase 1 後半で実装、`packages/agents/lib/llm-client.ts` で `cache_control` 付与 |

**結論**: 月額 5 万円上限はギリギリ達成可能。Phase 1 で実コスト測定後、**Writer の一部章で Gemini Flash 切替** または **Prompt Caching** を導入すれば 35,000〜45,000 円台に安定化できる見込み。

---

## 7. 将来の置き換え可能性

「コアを変えずに外側を交換できる」設計を維持するため、置換コストと条件を予め整理。

| 領域 | 現行 | 置換候補 | 置換コスト | 想定トリガー |
|---|---|---|---|---|
| ジョブキュー | graphile-worker | BullMQ + Redis | 中（worker 起動部とジョブ定義の書き換え）。タスクペイロード自体は `packages/contracts` で共有 | 並列度 > 50 が常時必要になった場合、または PG が IO ボトルネックに |
| LLM 抽象 | Vercel AI SDK (`AISdkClient`) + Anthropic Messages API SDK (`AgentSdkClient`) 二層 | Vercel AI SDK 単層 / LangChain.js | 低〜中（`LLMClient` interface 固定なので実装差し替えで完結） | Vercel AI SDK が `@ai-sdk/anthropic` 経由で `web_search_20250305` server tool を完全サポートしたら `AgentSdkClient` を廃止し AI SDK 単層に統合可能 |
| ホスティング | Railway | Fly.io / Render / 自前 K8s | 中（Dockerfile 化済みなら可搬性高）。R2 / Postgres は外部サービス継続使用 | Railway コスト急騰、Phase 4 でマルチリージョン要件発生 |
| 認証 | NextAuth Credentials | Clerk / Lucia / 自前 JWT | 低（シングルユーザーで影響軽微） | SaaS 化方針への転換 |
| PDF | @react-pdf/renderer | Puppeteer (Markdown→HTML→PDF) | 中（テンプレ層 `packages/output/pdf/` で吸収） | 5 万字本文での性能問題発覚 |
| Web 検索 | Anthropic web_search | Tavily / Brave / SerpAPI | 低（`packages/agents/tools/web-search.ts` のアダプタ差替） | Anthropic 以外モデルへの Marketer 切替 |
| メール | Resend | SendGrid / SES / Postmark | 低（`packages/notify/email.ts` で抽象化済） | Resend 障害や料金改定 |
| エラートラッキング | Sentry | Highlight / 自前ログ集約 | 低（`@sentry/*` 依存を抜くだけ） | Sentry コスト超過 |
| DB ORM | Prisma | Drizzle | 高（マイグレーション・型生成が全面入れ替え） | Prisma の Edge ランタイム制約が深刻化した場合（現状は Worker 側 Node なので問題なし） |
| 単価取得 | スクレイピング | 公式 SDK 単価 API (将来登場すれば) | 低（B-01〜B-02 を差替） | OpenAI/Anthropic が pricing API を提供開始した時点 |

---

## 8. Open Questions（後段で確定すべき）

| # | 問い | 提示先 | 推奨デフォルト |
|---|---|---|---|
| OQ-01 | `@react-pdf/renderer` で 5 万字 200 ページ PDF が許容時間 (30 秒以内) で生成できるか | `program-design` で実測ベンチ | フォールバック Puppeteer 切替判断は Phase 1 中盤 |
| OQ-02 | Anthropic web_search の月コストが想定 (Marketer 1 冊あたり数十円) に収まるか | Phase 1 計測 | 超過時は Tavily への切替を `model_assignments` 経由で有効化 |
| OQ-03 | KDP 自動入稿 (F-041) の Bot 検出対策（playwright-extra stealth で十分か） | Phase 3 設計時 | 十分でなければローカル PC 常駐 Worker に切替 |
| OQ-04 | Sentry free tier 5,000 events/月が Phase 2 で足りるか | Phase 2 計測 | 不足時は sample rate 0.5、それでも超過なら Highlight 無料枠に乗換 |
| OQ-05 | Resend 無料枠 3,000 通/月が修正コメント完了通知 (F-050) を含めて十分か | Phase 1 計測 | 超過時は $20/月プランへ |
| OQ-06 | 為替 API (`open.er-api.com`) の安定性 | Phase 1 運用 1 ヶ月で評価 | 不安定なら有料 Fixer.io / Wise API に切替 |
| OQ-07 | Prompt Caching (Anthropic) の効果（入力トークン削減率） | Phase 1 中盤に PoC | 30% 以上削減できれば Writer 標準で有効化 |

---

## 9. トレーサビリティ：機能 ID × 採用技術

主要機能 ID と本文書の選定 ID を 1 表で対応付け、`program-design` が参照する。

| 機能 ID | 機能名 (要約) | 対応する選定 ID |
|---|---|---|
| F-001 | テーマ候補生成 (Web Search) | C-05, C-06, A-02, A-03 |
| F-004 | 本文章単位執筆 | A-01, JQ-02 |
| F-005 | 校閲 | A-01 |
| F-007 | カバー画像生成 | C-07, E-04 |
| F-008 | Quality Judge | A-01 |
| F-009 | Prompt Optimizer | A-01 (Opus) |
| F-010, F-011 | ジョブ作成・並列実行 | C-04, JQ-01, JQ-02 |
| F-012 | Word 出力 | C-08, E-01, E-05 |
| F-013 | PDF 出力 | C-09, E-02, E-03, E-05 |
| F-014 | カバー PNG 出力 | C-07, E-04 |
| F-015 | R2 永続化 | C-10 |
| F-016 | リトライ・部分再開 | C-04, JQ-04, G-02 |
| F-022, F-023 | マルチプロバイダ抽象 / UI 切替 | A-01, A-02, A-04 |
| F-024 | 単価カタログ日次取得 | B-01, B-02, B-03, B-04, B-05, JQ-06 |
| F-025 | カタログダッシュボード | C-03, C-12, UI-01〜UI-04 |
| F-026, F-031 | A/B 比較 | A-01, G-03 |
| F-027〜F-031 | プロンプト管理 | C-03, C-12, UI-01〜UI-04 |
| F-032〜F-035 | コスト集計 | A-01 (usage 取得), C-03, G-03 |
| F-034, F-036 | コストアラート | D-01, D-02, G-03 |
| F-038 | 売上自動取得 | KDP-01 |
| F-041, F-042 | KDP 自動入稿 | KDP-01〜KDP-05 |
| F-043 | NextAuth Credentials | C-11 |
| F-044 | KDP 認証情報暗号化 | KDP-04 |
| F-045 | ジョブログ閲覧 | G-01, G-03 |
| F-049 | 修正コメント記録 | C-01, C-03, C-12, UI-01〜UI-04 |
| F-050 | 一括修正適用 | A-01, JQ-03, JQ-07, D-01 |
| F-051 | API キー UI 設定 | C-03, C-12, `@a2p/crypto` AES-256-GCM (T-01-08), UI-01〜UI-04 |
| F-052 | API キー接続テスト | C-05 (`@anthropic-ai/sdk` Messages API), A-01 (各 provider SDK via Vercel AI SDK), C-12 |
| 全 UI 機能 (S-001〜S-029) | デザイントークン適用 | C-12, UI-01, UI-02, UI-03, UI-04 |

全 P0 機能が最低 1 つの選定 ID にマップされていることを確認済み。

---

## 10. 申し送り（program-design 以降へ）

1. **LLM クライアントの二層構造を `packages/agents/lib/llm-client.ts` に固定**。`AISdkClient` (Vercel AI SDK、汎用) と `AgentSdkClient` (`@anthropic-ai/sdk` Messages API、Marketer 専用) を `LLMClient` interface で統一し、ファクトリで `model_assignments` から切替（A-01, A-02）。
2. **`token_usage` への INSERT は LLM クライアントの `withTokenLogging` middleware で必ず実行**。アプリケーションコードに直接書かない（F-032 漏れ防止）。
3. **環境変数は `packages/contracts/env.ts` で zod スキーマ化**し、起動時に検証。CI で `.env.example` との差分を検出するジョブを追加（J-01〜J-03）。
4. **graphile-worker の `task_identifier` 命名規約** を `program-design` で確定（例: `pipeline.book.writer`, `revision.book.apply`）。優先度は task ごとに `priority` カラム設定（JQ-03）。
5. **R2 のキー設計**（例: `books/{book_id}/artifacts/{kind}/{filename}`）を `program-design` で確定（F-015）。
6. **PDF 出力の性能ベンチ** を Phase 1 開始直後に実施し OQ-01 を解決。フォールバック判断は `docs/05` 改訂で記録。
7. **メールテンプレ 5 種** (`cost-exceeded`, `monthly-budget-alert`, `pricing-changed`, `kdp-2fa`, `revision-run-completed`) を `packages/notify/templates/` に react-email で実装。
8. **【2026-05 改訂】AgentSdkClient は `@anthropic-ai/sdk` (Anthropic 公式 Messages API クライアント) 採用に修正済**。当初候補だった `@anthropic-ai/claude-agent-sdk` は SP-02 T-02-03 実装中に「Claude Code CLI (`claude` バイナリ) を子プロセス spawn するラッパ」であることが判明し撤回。理由：(a) `tools` 識別子が CLI 組込 (`WebSearch` 等) で Messages API の `web_search_20250305` と一致せず Marketer の Web 検索要件と整合しない、(b) Railway 本番で CLI バイナリ同梱＋認証セットアップが必須となり Phase 1 MVP スコープ逸脱。Messages API クライアントへの切替により純 Node プロセスで動作し、`tools: [{ type: "web_search_20250305", ... }]` を直接指定可能。既存実装の T-02-01 (`LLMClient` interface)、T-02-02 (`AISdkClient`)、T-02-13 (`getApiKey` ヘルパ) との整合は維持（`AgentSdkClient` も `LLMClient` 実装かつ `getApiKey('anthropic')` 経由でキー取得）。Marketer のみが `AgentSdkClient` を使い、Writer/Editor/Judge/Thumbnail/Optimizer は引き続き `AISdkClient` を使う二層構造は変更なし。
