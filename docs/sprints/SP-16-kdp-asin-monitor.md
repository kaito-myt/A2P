# SP-16 kdp-asin-monitor (Phase 3 skelton)

> 本ファイルは枠のみ。タスク詳細は SP-15 完了後に pm を計画モードで再起動して詳細化する。

## 1. 目的

ASIN 自動取り込み (F-042) と KDP 自動入稿後の運用安定化（スクショ保管 / 失敗リトライ / Bookshelf スキャン）を実装し、Phase 3 を完了させる。これにより F-038 売上自動取得 (Phase 2 で実装済) が新出版書籍にも自動連動する。

## 2. 対応画面 / 対応機能 ID

- **F-042** KDP 入稿後の ASIN 取り込み・書籍メタ更新
- 関連画面: **S-016** ASIN 取り込みステータス追加
- 関連: **F-038** (Phase 2) の自動取得対象に新出版書籍を自動追加

## 3. 想定タスク数

**4〜6 タスク**（詳細化時の目安）。

### 想定タスクスケッチ

| 概要 | 工数 |
|---|---|
| `kdp.asin.fetch` ワーカタスク (Bookshelf スキャン + `Book.asin` 更新) | M |
| `kdp.submit` 完了時に翌日 09:00 JST で `kdp.asin.fetch` を runAt enqueue | S |
| S-016 への ASIN 取り込みステータス追加 | S |
| Bookshelf スキャン失敗時のリトライ (max 5) | S |
| Phase 3 完了レポート (`docs/operations/phase3-summary.md`) | S |
| Vitest + Playwright E2E | M |

## 4. 完了判定（暫定）

- pm `MODE: REVIEW TARGET: SP-16` で `## PHASE_COMPLETE`
- 入稿翌日に ASIN が必ず取り込まれる (F-042 受け入れ基準)
- Phase 3 PHASE_COMPLETE: pm `MODE: REVIEW TARGET: Phase 3`
