---
description: programmer → code-reviewer → e2e-tester を「APPROVED かつ PASS」まで反復させる実装ループ。引数にタスク ID か自然言語の指示を渡す。
argument-hint: "<タスク ID or 指示文>"
---

You are orchestrating the `/iterate` loop for the A2P project.

Argument: $ARGUMENTS

## Loop protocol

`programmer` の呼び出しを 1 iteration とカウントし、**最大 5 iterations** まで繰り返す。

各 iteration の手順：

### Step 1: programmer

`programmer` サブエージェントを呼び出す。
- 初回: `$ARGUMENTS` をそのままプロンプトに渡す
- 2 回目以降: 直前の反省フィードバック（reviewer または e2e-tester からのもの）を次のフォーマットで先頭に付加してから `$ARGUMENTS` を続ける：

  ```
  Previous feedback (must address all items):

  [code-reviewer feedback if any]
  <verbatim>

  [e2e-tester feedback if any]
  <verbatim>

  Original task:
  $ARGUMENTS
  ```

programmer が `## DONE` で終わるのを待つ。
- `## BLOCKED: <理由>` で終わった場合: ループ停止、ユーザーに blocker を報告して終了。
- いずれでもない: `## BLOCKED: terminator missing` 扱いで停止。

### Step 2: code-reviewer

`code-reviewer` サブエージェントを呼び出す。コンテキストとして以下を渡す：
- 元のタスク (`$ARGUMENTS`)
- programmer が変更したファイルのリスト（programmer 出力から抽出）

verdict を待つ：
- `## APPROVED` → Step 3 へ進む
- `## REQUEST_CHANGES` → reviewer の指摘リストを「code-reviewer feedback」として保持し、Step 1 へ戻る（次 iteration へ）
- `## ESCALATE: <理由>` → ループ停止、ユーザーに escalation を報告して終了

### Step 3: e2e-tester

`e2e-tester` サブエージェントを呼び出す。コンテキストとして以下を渡す：
- 元のタスク (`$ARGUMENTS`)
- 影響を受けた機能 ID（タスク文中、または programmer 出力から推定可能なもの）
- 「コードレビューは APPROVED 済み。実装が機能要件 (docs/02) のユースケースを満たすか E2E で検証してほしい」と明示

結果を待つ：
- `## DONE` (全テスト PASS) → ループ成功終了。ユーザーに 3〜5 行のサマリを返す（実装内容 / 変更ファイル数 / レビュー verdict / E2E 結果）。
- `## BLOCKED: <理由>` (テスト FAIL、または環境問題) → 失敗詳細を「e2e-tester feedback」として保持し、**code-reviewer の指摘は破棄して** Step 1 へ戻る（次 iteration へ）。

注: E2E 段階で失敗した場合、コード修正後は再度コードレビューも通す必要があるため、次 iteration は必ず Step 1→2→3 を全部走らせる。Step 2 をスキップしてはいけない。

## Escalation after 5 iterations

5 iteration 経過しても `Step 3: DONE` に到達しなければ、6 回目を回さず以下を出力して終了：

```
## /iterate ESCALATED
- Task: $ARGUMENTS
- 5 iterations did not pass all three stages.
- Last code-reviewer verdict: <APPROVED/REQUEST_CHANGES>
- Last e2e-tester result: <DONE/BLOCKED with detail>
- 推奨される次の一手:
  - docs/05-program-design.md を見直す / タスク定義を再分解する / e2e-tester の前提環境を確認する
```

## Rules

- 自分でコードを編集しない。コード変更は `programmer` の責任。
- verdict を独自判断しない。`code-reviewer` と `e2e-tester` の出力末尾の文字列契約に従う。
- フィードバックは要約せず **verbatim** で次 iteration に渡す。
- 各 iteration の冒頭に短いステータスをユーザーに出力する：
  - `Iteration N/5: programmer → code-reviewer (verdict: ...) → e2e-tester (result: ...)`
- code-reviewer が REQUEST_CHANGES の場合、その iteration は e2e-tester までは進めず Step 1 に戻る（E2E はコードが安定するまで走らせない）。
- ターミネーター文字列 (`## DONE` / `## BLOCKED` / `## APPROVED` / `## REQUEST_CHANGES` / `## ESCALATE`) が無いサブエージェント応答は契約違反として扱い、停止する。
