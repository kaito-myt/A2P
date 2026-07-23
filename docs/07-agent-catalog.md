# 07 — ランタイムエージェント・カタログ（全社横断インデックス）

このドキュメントは、**デプロイされたアプリの中で本を作り・売り・経営判断する「ランタイムエージェント」**を
サブシステム横断で一望するためのインデックスである。各エージェントの詳細仕様（I/O スキーマ・
プロンプト・シーケンス）は参照先ドキュメントに置き、ここでは**「誰が・どの役割で・いつ動くか」**を
一枚で俯瞰できるようにする（詳細の二重管理を避けてドリフトを防ぐ）。

> **2 つのエージェント層を混同しない**（CLAUDE.md 参照）。本書が扱うのは **ランタイムエージェント**
> （`packages/agents/`、Claude Agent SDK / AISdkClient・AgentSdkClient 経由）だけ。開発を回す
> **ハーネスエージェント**（`.claude/agents/`：programmer / code-reviewer 等）は対象外。

## 真実源（Source of Truth）

- **プロンプト本文**: DB `prompts` テーブル（active 版・ジャンル特化可）。seed は `packages/db/apply-*.ts`。
- **使用モデル**: DB `model_assignments`（役割×ジャンル）。本書の「モデル」列は seed 時の既定であり、
  実行時の確定値は DB を参照する。
- **役割定義（union）**: `packages/contracts/src/agents/llm-client.ts` の `AgentRole`。
- **コスト**: すべての LLM/画像/TTS 呼び出しは `token_usage` に記録（CLAUDE.md ハードルール5）。

---

## A. 書籍生産パイプライン

企画→執筆→編集→表紙→品質→（プロンプト最適化）。詳細は **docs/05 §6.3**、機能要件は **docs/02**。

| role | 日本語名 | 役割（1行） | 既定モデル | 定義 | トリガー |
|---|---|---|---|---|---|
| `marketer` | マーケター（企画） | Amazon 売れ筋を web_search でリサーチし、テーマ候補＋需要/競合 signals を出す | Opus (web_search) | `packages/agents/src/marketer/` | テーマ生成 / `pipeline.book.*` |
| `marketer_plan` | メタデータ立案 | 書籍のKDP説明文・キーワード・カテゴリ草案（MarketerMetadata） | Opus | 同上 | 出版準備 |
| `writer` | ライター | アウトライン生成＋章本文執筆（章ごと、文字数許容 ±35%） | Opus | `packages/agents/src/writer/` | `pipeline.book.write*` |
| `outline_review` | 構成校正 | 章立ての重複/網羅漏れ/順序/粒度をレビュー | Sonnet | 契約=`agents/outline-review` | アウトライン後 |
| `editor` | 編集 | 章本文の校正・整文・トーン統一 | Opus | `packages/agents/src/editor/` | `pipeline.book.edit` |
| `readings` | 読み仮名 | タイトル/著者名のカタカナ読み生成（ローマ字は決定的変換） | Sonnet | `apply-readings.ts` | 出版準備 (F-020b) |
| `cover_art_direction` | アートディレクション | web_search で売れ筋表紙をリサーチし、本ごとの画風を決めて画像チームへ発注 | Opus (web_search) | `apply-cover-art-direction.ts` | 表紙生成前 |
| `thumbnail_text` | 表紙コピー | タイトル/サブタイトル/帯コピー（band_copy）等の表紙テキスト設計 | Opus | `packages/agents/src/thumbnail/` | 表紙生成 |
| `thumbnail_image` | 表紙画像 | 文字なしイラストを画像生成（実フォント合成は `compose-cover.ts`） | OpenAI 画像(`OPENAI_IMAGE_MODEL`=既定 gpt-image-2) | `tools/image-gen.ts` | 表紙生成 |
| `cover_text_check` | 表紙文字チェック | 生成表紙の文字崩れをビジョン検証（再描画パスの採否判断） | Sonnet | `apply-cover-text-check.ts` | 表紙生成後 |
| `judge` | 品質判定 | 完成本の品質採点・合否（Phase 2） | Sonnet | docs/05 §6.3.5 | `pipeline.book.judge` |
| `revision` | 修正適用 | 承認ゲートの修正指示を本文/表紙へ反映（revision.book.apply） | Opus | docs/05 §6.3.6 | 修正依頼時 |
| `optimizer` | プロンプト最適化 | 実績を基にプロンプト改善案を生成（Prompt Optimizer, Phase 2） | Sonnet | docs/05 §6.3.7 | バッチ |
| `promoter` | 販促プランナー | 出版後の販促施策プラン（価格戦略/レビュー/告知文）を生成 | Opus | `apply-promoter.ts` | `pipeline.book.promotion.generate` |

---

## B. 販促・SNS 運用

アカウント戦略の設計から、投稿生成・日次見直し・TikTok 動画制作まで。詳細は **docs/05 の販促 F-052〜F-063**。

| role | 日本語名 | 役割（1行） | 既定モデル | 定義 | トリガー |
|---|---|---|---|---|---|
| `sns_strategist` | アカウント戦略家 | 在庫本のジャンル/読者から concept/表示名/bio/発信の柱/トーン/ハッシュタグ/アイコン・カバー画像を設計 (F-057) | Opus | `apply-sns-strategist.ts` | `promotion.strategy.generate` |
| `account_strategist` | 多アカウント戦略 | 複数運用アカウントのポジショニング/差別化を設計（Org P4 増分1） | Opus | `apply-org-p4.ts` | `org.plan` 系 |
| `content_creator` | 育成投稿クリエイター | 発信の柱から「価値提供型」投稿を生成（宣伝色なし・フォロワー獲得, F-059） | Opus | `apply-content-creator.ts` | `promotion.content.generate` |
| `content_optimizer` | SNS 日次見直し | 戦略のある各chの直近3日 scheduled 投稿を非破壊で推敲（メタ混入禁止, F-061） | Sonnet | `apply-content-optimizer.ts` | `promotion.review.daily`（日次cron） |
| `tiktok_scenario` | 台本・構成 | 強フック→小出し→引き（射幸心）の構成台本 | Opus | `packages/agents/src/tiktok-video/` | `promotion.video.generate` / 投稿時 |
| `tiktok_creator` | 絵コンテ | 各ビートの背景画像プロンプト＋テロップ | Sonnet | 同上 | 同上 |
| `tiktok_editor` | 尺配分・編集 | カット/テロップ整形→VideoScript 確定 | Sonnet | 同上 | 同上 |
| `tiktok_proofreader` | 校閲 | 誤字/事実/過度な誇張の是正 | Sonnet | 同上 | 同上 |
| `tiktok_marketer` | 訴求強化 | フック/CTA/ハッシュタグの最終強化 | Opus | 同上 | 同上 |
| `cost_optimizer` | コスト分析 | 直近30日の token_usage を役割×モデルで集計し改善案＋推定削減額を提案 (F-062) | Sonnet | `apply-cost-optimizer.ts` | `cost.optimize.weekly`（週次cron） |

**TikTok 動画レンダリング（非LLM）**: `video-render.ts` `renderSlideVideo` が
シーン毎に AI背景画像→Noto Sans JP テロップ焼込→OpenAI TTS ナレーション→ffmpeg で 1080×1920 化→
concat で 9:16 mp4 を生成（TTS は `token_usage role='tts_audio'`）。
**投稿ポート**: instagram=Make Webhook / **tiktok=Content Posting API 直叩き**（`tiktok-publisher-port.ts`、
アプリ内 OAuth 接続。F-063）/ x=X API v2 (OAuth1.0a) / note・blog=Webhook。

---

## C. 経営組織（Org レイヤー）

CEO → 本部長 → 担当者 の 3 階層で「いつ・何を・どの本に・どの予算で」を意思決定・分解・検証する。
詳細は **docs/06 §4**（役割定義）・§2〜3（組織図/経営サイクル）。

### C-1 経営層・本部長

| role | 日本語名 | 役割（1行） | 既定モデル |
|---|---|---|---|
| `ceo` | 社長 | 全社状況を俯瞰し方針(Objective)・本部別予算配分・優先順位を決定、本部長へ委任 | Opus |
| `editorial_mgr` | 制作本部長 | どの本を作るか・優先度を決め企画→執筆→編集→表紙→品質へ分解 | Opus (web_search) |
| `publish_mgr` | 出版本部長 | 品質OK本のKDP出版方針（メタ/価格/カテゴリ/キーワード）を決めタスク化 | Opus |
| `analytics_mgr` | 分析本部長 | 売上・市場・KPIの分析計画を立て示唆をCEO/各本部へ還元 | Opus (web_search) |
| `promo_mgr` | 販促本部長 | 書籍ごと販促戦略・アカウント振り分け・新規要否をToDo化 | Opus (web_search) |
| `ops_mgr` | 運用本部長 | ジョブ健全性監視・スタック復旧・エラートリアージ（横断） | Sonnet |
| `finance_mgr` | 経営管理(CFO) | 予算・コスト統制、投資対効果の判断 | Opus |

### C-2 担当者（ワーカー・多くは非LLM/集計）

| role | 日本語名 | 役割（1行） |
|---|---|---|
| `market_analyst` | 市場アナリスト | ジャンル/競合/検索需要のリサーチ・次テーマ提案（web_search） |
| `sales_analyst` | 売上アナリスト | 売上の前後比較・トレンド・書籍別ランキング分析 |
| `promo_analyst` | 販促アナリスト | 販促投稿の効果検証（v1設計） |
| `cost_accountant` | コスト会計 | token_usage をタスク/本部/書籍に集計しコスト確定 |
| `metadata_worker` | 入稿担当 | KDPメタデータ/キーワード/カテゴリ/価格の草案・整備 |

> 注: 制作の実作業（marketer/writer/editor/thumbnail/judge）は Org からは
> **既存ランタイムエージェントの再利用**として呼ばれる（本部長が「担当者」として使う手足）。
> KDP公開・アカウント作成・接続は人手ゲート（`needs_human`）。

---

## 横断メモ

- **クライアント2層**（docs/03/05）: `AISdkClient`(Vercel AI SDK) = 汎用 LLM 呼び出し全般 /
  `AgentSdkClient`(@anthropic-ai/sdk) = Marketer 系の web_search server tool 利用時。
- **ジャンル**: `packages/contracts/src/genres.ts`（29種）が単一の真実源。エージェントには
  日本語ラベル(genreLabel)を注入。
- **プロンプト/モデルは DB が真実源**（CLAUDE.md ハードルール4）。本書の一覧が実体とズレたら
  DB(`prompts`/`model_assignments`) と seed(`apply-*.ts`) を正とし、本書を更新する。
