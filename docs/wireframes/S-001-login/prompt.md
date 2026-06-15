# S-001 ログイン — ChatGPT ワイヤーフレーム生成プロンプト

## 画面情報
- 画面 ID: S-001
- 画面名: ログイン
- 対応機能 ID: F-043
- 元設計書: `docs/04-ui-design.md` §4 S-001
- 想定画像:
  - `desktop.png` — デスクトップ標準ビュー
  - `mobile.png` — モバイル 1 カラム
  - `loading.png` — 認証処理中
  - `error.png` — 認証失敗 / ロック状態

## ChatGPT 使い方
1. ChatGPT (GPT-4o / 画像生成有効) を開く
2. 下記「共通プロンプト」と任意の「{バリアント} プロンプト」を結合してコピー
3. ChatGPT に貼り付けて画像生成
4. 出力 PNG を本ディレクトリに上記ファイル名で保存

---

## 共通プロンプト（全画像で先頭に置く）

```
You are a senior UX designer creating a low-fidelity wireframe for a Japanese web application called "A2P" (Amazon KDP publishing automation tool, single-operator use).

Output as a single wireframe image with the following style rules:
- Pure black-and-white. Use light gray only for de-emphasis (placeholders, disabled states). No other colors.
- Use rectangular blocks for sections. Label each section with a Japanese heading.
- Buttons: rendered as `[ボタン名 ]` (square brackets, text only).
- Input fields: rendered as horizontal lines `_______` with label above.
- Dropdowns: rendered as `[ラベル ▾]`.
- Avatars/icons: placeholder squares with one-letter labels (e.g. `[A]`).
- Tables: show realistic row count (8–12 rows), not 2–3.
- Lists: show 5–10 items where applicable.
- Annotations and labels: **all in Japanese**.
- No real photos, no logos, no decorative graphics.
- No specific colors, no shadows, no rounded corners (sharp rectangles only).
- Show realistic information density. Avoid empty whitespace unless the variant is the empty state.

NOTE for this screen (S-001 ログイン): This is the ONLY screen WITHOUT the persistent header/sidebar. Do not render header or sidebar here.
```

---

## desktop.png プロンプト

```
Layout: 1440x900 pixels, desktop browser view.

No header, no sidebar (login screen exception).

Main content: centered card (480px wide, 480px tall), with white background and 1px outline:

### Section 1: ブランド
- 上部中央
- "A2P" ワードマーク（テキストのみ、24pt）
- サブコピー: "Amazon Automated Publishing"

### Section 2: ログインフォーム
- 中央
- ラベル "ユーザー名" + 入力欄 `_______________`
- ラベル "パスワード" + マスク入力欄 `●●●●●●●●` + 右端に `[表示]` トグルボタン
- プライマリボタン `[ ログイン ]`（カード幅いっぱい）

### Section 3: フッター注記
- 下部
- "シングルユーザー運用 / Phase 1" のような小さい注記
- "ログインに失敗したアカウントは 5 回で 15 分ロックされます" のヒント文

画面の残りはダーク無地背景（薄いグレー塗り）、装飾なし。
```

---

## mobile.png プロンプト

```
Layout: 375x812 pixels (iPhone portrait), single column.

No header, no sidebar.

Main content (縦に積む、横余白 24px):
1. 中央上 1/3 に "A2P" ワードマーク + サブコピー "Amazon Automated Publishing"
2. ユーザー名入力欄（ラベル上、入力下）
3. パスワード入力欄 + `[表示]` トグル
4. `[ ログイン ]` プライマリボタン（横幅いっぱい）
5. 下部に "5 回失敗で 15 分ロック" の注記

背景は薄いグレー、フォーム部分のみ白カード。
```

---

## loading.png プロンプト

```
Layout: same as desktop.png

Difference:
- `[ ログイン ]` ボタンが disabled 表示（薄グレー）
- ボタン内テキストの左に小さいスピナー（円形破線）を描画
- ボタンラベルは "認証中..." に置換
- 入力欄は disabled（薄グレー塗り）
```

---

## error.png プロンプト

```
Layout: same as desktop.png

Difference:
- フォームの上に赤系（destructive）の細いバナー: "ユーザー名またはパスワードが正しくありません（残り 3 回）"
- もしくはロック中バリエーション: "5 回失敗のため 15 分ロック中（残り 12:34）"
- 入力欄に赤い細枠
- `[ ログイン ]` ボタンは押下可能（赤枠ではない）
```

---

## 設計意図メモ（ChatGPT には渡さない）

- S-001 は他全画面と異なり Header/Sidebar を持たない例外。共通プロンプトに明示注記を入れることで ChatGPT がうっかり描画するのを防ぐ。
- F-043 受け入れ基準「5 回失敗で 15 分ロック」を error バリアントで明示し、運用者が認識できるようにする。
- 装飾を排し、シングルユーザー運用らしい質素なログインに留める（業務要件の「実務ツール志向」原則）。
