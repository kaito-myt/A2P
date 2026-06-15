# SP-15 kdp-submit-2fa (Phase 3 skelton)

> 本ファイルは枠のみ。タスク詳細は SP-14 完了後に pm を計画モードで再起動して詳細化する。

## 1. 目的

KDP 自動入稿本体 (F-041) を実装し、2FA push-and-wait（Resend `kdp-2fa` テンプレ + 承認用ワンタイム URL）と S-016 モニター UI を完成させる。1 冊あたり 10 分以内に「公開待ち」状態まで到達することを受け入れ基準とする。

## 2. 対応機能 ID

- **F-041** KDP 自動入稿（Playwright、2FA は push-and-wait）
- 関連画面: **S-015** SubmitToKdpButton 有効化、**S-016** KDP 自動入稿モニター
- 関連選定: **KDP-03** (2FA 通知)、**D-01** Resend `kdp-2fa` テンプレ（`docs/03 §10 申し送り 7` 残り 1 件）

## 3. 想定タスク数

**8〜10 タスク**（詳細化時の目安）。

### 想定タスクスケッチ

| 概要 | 工数 |
|---|---|
| `kdp.submit` ワーカタスク本体（ログイン → メタデータ → アップロード → 価格 → 公開待ち） | L |
| `Kdp2FaCode` + Resend `kdp-2fa` テンプレ + 承認画面 RH `/kdp/2fa/[jobId]` | L |
| `submitToKdp` SA 本実装 + S-015 SubmitToKdpButton 有効化 | M |
| S-016 モニター UI (SubmissionJobList + TwoFaPrompt + ScreenshotPreview + RetryButton) | L |
| 失敗時のスクショ R2 保存 + RetryButton | M |
| 2FA タイムアウト (10 分) → ジョブ失敗 + 運営者通知 | S |
| Vitest + Playwright E2E (UC-05、ローカルダミー KDP) | L |

## 4. 完了判定（暫定）

- pm `MODE: REVIEW TARGET: SP-15` で `## PHASE_COMPLETE`
- 本番 KDP で 1 冊以上を「公開待ち」まで到達
- UC-05 E2E spec PASS
- 全 5 メールテンプレ完成 (`docs/03 §10 申し送り 7` 完了)
