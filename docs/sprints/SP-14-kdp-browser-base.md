# SP-14 kdp-browser-base (Phase 3 skelton)

> 本ファイルは枠のみ。タスク詳細は Phase 2 完了後に pm を計画モードで再起動して詳細化する。

## 1. 目的

Phase 3 の入口。Playwright + stealth プラグインで KDP サイトへの自動アクセス基盤を整備し、KDP 認証情報暗号化 (SP-01 で枠を作った `packages/crypto` の本格運用) + Dockerfile に Chromium 同梱 + ローカルダミー HTML での E2E fixture を作る。`OQ-03` (Bot 検出突破可否) を実機で確認する PoC を含む。

## 2. 対応機能 ID

- **KDP-01〜KDP-05**（`docs/03 §C` KDP 自動入稿の選定群）
- **F-044** KDP 認証情報暗号化の本格運用
- 関連リスク: **R-06** (Bot 検出 → 失敗時はローカル PC 常駐 worker 切替判断)

## 3. 想定タスク数

**6〜8 タスク**（詳細化時の目安）。

### 想定タスクスケッチ

| 概要 | 工数 |
|---|---|
| `packages/kdp/browser.ts` (playwright-extra + stealth) | M |
| `apps/worker/Dockerfile` に Chromium インストール手順追加 | S |
| KDP ログインフロー PoC（実 KDP で 3 回連続成功率を計測） | L |
| ローカルダミー HTML サーバ fixture (`tests/fixtures/kdp-stub/`) | M |
| KDP 認証情報の SP-01 crypto との結合（Account 作成時に encrypt 保存 + worker 内で decrypt） | M |
| Bot 検出失敗時の「ローカル PC 常駐 worker 切替」判断レポート | S |
| Vitest (stub) + 手動ローカル PoC レポート | M |

## 4. 完了判定（暫定）

- pm `MODE: REVIEW TARGET: SP-14` で `## PHASE_COMPLETE`
- KDP ログインが 3 回連続成功 (PoC レポート) または ローカル PC 常駐切替が決定
- `packages/kdp/` の基盤が SP-15 から呼べる状態
