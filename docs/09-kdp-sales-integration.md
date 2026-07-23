# 09 — KDP 売上連携 設計 (F-038 拡張 / Phase 3 最重要課題)

> KDP から売上（ロイヤリティ・販売数・KENP 既読）を取得し `sales_records` に取り込む
> 仕組みの設計。取得方式は **Phase 1: 手動レポートアップロード → Phase 2: Playwright 自動DL**
> の段階実装。データ源は **KDP のダウンロードレポート (xlsx/csv)** に一本化する。

## 0. 背景と前提

- **KDP には売上 API が無い。** レポート画面は React の SPA（ダッシュボード）で、
  HTML に数値が構造化されて出ないため **HTML スクレイプは非現実的**（旧 `parseKdpSalesHtml`
  の `tr.report-row` 等の独自セレクタは実 KDP では空振りする）。
- **確実なデータ源＝KDP の「レポートのダウンロード」**（Excel/CSV）。生成レポートには
  〔タイトル / ASIN / マーケットプレイス / 販売数 / KENP 既読 / ロイヤリティ / 通貨〕が
  構造化されて含まれる。これをパースするのが唯一堅牢な方法。
- 既存資産（そのまま活かす）:
  - DB: `sales_records`（月次×書籍）、`sales_fetch_runs`（実行履歴, `2fa_waiting` 対応）、
    `kdp_2fa_codes`（2FA push-and-wait）、`accounts.kdp_credentials_enc`（暗号化認証情報）
  - UI: アカウント編集での KDP 認証情報入力、売上 KPI 画面（サマリ / トレンド / 実行状況）
  - Worker: `sales.fetch` タスク（実行履歴・復号・パース・ASIN→book_id・upsert の骨格）、
    `sales-fetch-dispatcher`、Playwright ログインコード（email/pw/TOTP/2FA 待受）
  - **唯一の欠落 = 実データ取得**。本設計はここを「レポートファイルのパース」に差し替える。

## 1. データモデル変更

`sales_records` に販売数・KENP を追加（現状 royalty しか保持していない）。

```prisma
model SalesRecord {
  // ...既存...
  royalty_jpy  Int      // 円換算・全マーケットプレイス合算の月次ロイヤリティ
  units_sold   Int      @default(0)  // 追加: 有料販売部数(返品控除後 net)
  kenp_read    Int      @default(0)  // 追加: KU/KOLL 既読ページ数
  review_count Int      @default(0)  // 商品ページ由来 (Phase で別取得。当面 0)
  avg_stars    Decimal? @db.Decimal(3,2) // 同上
  bsr          Int?                       // 同上
  source       String   // manual_upload | auto | manual
  // ...
}
```

- 本番マイグレーションは `ADD COLUMN IF NOT EXISTS`（冪等）。
- `source` の値を拡張: `manual_upload`（レポートアップロード）/ `auto`（Playwright 自動DL）/
  `manual`（手入力・将来）。

## 2. 取り込みの正規化ルール（共通コア）

Phase 1/2 とも、パース後は同じ正規化コア `packages/db` or `@a2p/contracts` の純関数を通す。

- **集約単位**: (ASIN, year_month)。マーケットプレイスを跨いで合算。
- **通貨換算**: レポートはマーケットプレイス通貨建て。JPY はそのまま合算。非 JPY 行は
  FX レートで円換算（USD は既存 `model_catalog.fx_rate_usd_jpy` を代表値に再利用。他通貨は
  当面 best-effort、未対応通貨は警告ログ＋その行スキップして合計から除外）。JP 単独運営では
  .co.jp が支配的なので実害は小さい。将来は日次 FX テーブルを導入。
- **ロイヤリティ内訳**: レポートのロイヤリティは「有料販売分」＋「KENP 既読分(KDP Select
  グローバル基金)」を含む。両方を合算して `royalty_jpy` にする。`kenp_read` はページ数を別途保持。
- **ASIN→book_id**: `books.asin` で解決。未知 ASIN の行はスキップ（warn ログ、throw しない）。
  ASIN 未設定の本は `kdp-asin-fetch` で先に埋める運用。
- **冪等**: (book_id, year_month) で upsert。再アップロードは最新値で上書き（`source` も更新）。

## 3. Phase 1 — 手動レポートアップロード（MVP・確実に今動く）

運営者が KDP でレポート(.xlsx/.csv)をDL → A2P にアップロード → パース → プレビュー確認 → 取込。

### 3.1 フロー
1. 売上画面（S-018 系）に「レポート取込」導線。アカウント + 対象年月 + ファイルを指定。
2. サーバアクション `importSalesReport`:
   - ファイル(xlsx/csv)を受け取り、全シートを走査。ヘッダ行を検出。
   - **ヘッダ駆動のカラムマッピング**（KDP の EN/JA ヘッダ表記ゆれに耐性）:
     - ASIN/ISBN: `ASIN`, `ASIN/ISBN`
     - 販売数: `Units Sold`, `Net Units Sold`, `注文数`, `販売部数`
     - KENP: `Kindle Edition Normalized Pages (KENP) Read`, `KENP Read`, `既読ページ数`
     - ロイヤリティ: `Royalty`, `ロイヤリティ`
     - 通貨: `Currency`, `通貨`
     - マーケットプレイス: `Marketplace`, `マーケットプレイス`
   - 自動判定に失敗した列は UI で運営者が手動マッピング。
   - 正規化コアで (ASIN, ym) 集約 → 円換算 → **プレビュー**（マッピング結果・行数・合計・未知
     ASIN 件数）を返す（この時点では DB 未反映）。
3. 運営者がプレビューを確認して「取込」→ `SalesRecord` upsert（`source='manual_upload'`）。
   `sales_fetch_runs` に手動取込の履歴も記録（status=done, records_upserted）。

### 3.2 実装単位（タスク）
- **T-KS-01** schema: `sales_records += units_sold, kenp_read`（Prisma + prod ALTER 冪等）。
- **T-KS-02** parser: `packages/agents` or `packages/db` に `parseKdpReportWorkbook(buffer)` を新設
  （`xlsx`/`exceljs` でシート走査 → ヘッダ検出 → 行抽出 → `KdpReportRow[]`）。純関数・Vitest。
- **T-KS-03** 正規化コア: `normalizeSalesRows(rows, {ym, fx})` → (book_id 解決前の) `NormalizedSalesRow[]`
  ＋合計・警告。純関数・Vitest。
- **T-KS-04** サーバアクション `importSalesReport`（preview モード / commit モード）。
- **T-KS-05** UI: 売上画面に「レポート取込」モーダル（ファイル選択 → プレビュー表 → 取込）。
- **T-KS-06** e2e: 代表的な xlsx/csv fixture で preview→commit→SalesRecord 反映。

### 3.3 なぜ手動先行か
認証情報保存もスクレイプ調整も不要で、**実 KDP データが即・確実に入る**。Phase 2 の自動化は
「同じパーサに流すファイルを、人間ではなくブラウザが取ってくる」だけの差分になり、パーサ・
正規化・UI プレビューを Phase 1 で作り切ることで自動化の土台が固まる。

## 4. Phase 2 — Playwright 自動ダウンロード（全自動）

既存ログインコード（`playwright-browser-port.ts`）を流用し、**HTML スクレイプではなく
「レポート生成→ファイルDL」**に作り替える。取得ファイルを Phase 1 と同じパーサ/正規化に流す。

### 4.1 変更点
- `browser-port.ts` の契約を `fetchReportHtml` → `downloadReportFile(): { ok, buffer, filename }`
  に拡張（HTML 版は互換のため残置可だが新経路は file を返す）。
- Playwright 手順: ログイン(2FA) → レポート画面 → 期間指定 → 「レポートを生成/ダウンロード」を
  クリック → `page.waitForEvent('download')` でファイル取得 → buffer 化。
- 2FA: TOTP 自動（`totp_secret` あり）/ 無ければ `kdp_2fa_codes` に待受を作り、運営者が UI で
  コード入力 → 再開（push-and-wait。既存 `2fa_waiting` フローを完走させる）。
- `sales.fetch` タスク: 取得 buffer を Phase 1 の `parseKdpReportWorkbook` → `normalizeSalesRows`
  → upsert に接続（`source='auto'`）。
- スケジュール: `sales-fetch-dispatcher` を日次（速報）＋月初（確定）で起動。KDP はロイヤリティが
  月次確定なので、当月は速報値・確定後に上書きする運用。

### 4.2 実 KDP 調整（実アカウント必須）
- レポート画面 URL / 期間セレクタ / ダウンロードボタンのセレクタは実アカウントで確定する。
  `saveDebugArtifacts`（screenshot+html を R2 保存）を活用してセレクタを詰める。
- Railway コンテナに Chromium 同梱（Dockerfile）。既に LAUNCH_ARGS で `--no-sandbox` 等を用意済み。

## 5. 観測性・失敗方針
- 全取込は `sales_fetch_runs` に記録（手動=`manual_upload` 起点でも履歴を残す）。
- パースは throw しない（部分成功）。未知 ASIN・未対応通貨・マッピング失敗はカウントして
  プレビュー/実行結果に表示。
- 取込結果は売上 KPI 画面（既存）に即反映。コスト×売上の損益は既存 KPI 集計を利用。

## 6. スコープ外（別途）
- レビュー数 / 平均星 / BSR は KDP レポートに無い（Amazon 商品ページ由来）。別スクレイプ機能
  として後日（`sales_records.review_count/avg_stars/bsr` は当面 0/null のまま）。
- 日次 FX テーブル（当面は代表レート）。

## 7. 申し送り（実装順）
1. T-KS-01 schema → T-KS-02 parser → T-KS-03 正規化コア（純関数＋テストを先に固める）
2. T-KS-04 アクション → T-KS-05 UI（preview→commit）→ T-KS-06 e2e
3. （Phase 2）browser-port を file DL に拡張 → `sales.fetch` を新パーサに接続 → 実 KDP 調整
