# Wireframes

A2P プロジェクトのワイヤーフレーム成果物を保管するディレクトリ。

## ディレクトリ構成

```
docs/wireframes/
  README.md                  ← このファイル
  S-001-dashboard/
    prompt.md                ← ChatGPT 投入用プロンプト（designer エージェントが生成）
    desktop.png              ← ChatGPT 出力（運営者が手動保存）
    mobile.png
    empty.png                ← 該当画面のみ
  S-002-new-project/
    prompt.md
    desktop.png
    mobile.png
  ...
```

- **1 画面 = 1 ディレクトリ**。ディレクトリ名は `S-{画面ID}-{kebab-case-slug}`
- 各ディレクトリは `prompt.md` + 必要な画像（PNG）で構成
- 画像ファイル名は固定: `desktop.png` / `mobile.png` / `empty.png` / `loading.png` / `error.png`

## ワークフロー

1. **prompt.md の生成（designer エージェント）**
   - `docs/04-ui-design.md` が更新されたら `designer` エージェントを起動
   - 全画面分の `prompt.md` が自動生成される
   - 既存の画像 PNG は触られない（プロンプトのみ更新）

2. **画像生成（運営者の手作業）**
   - 各 `prompt.md` を開き、「共通プロンプト」と任意のバリアントプロンプトを結合してコピー
   - ChatGPT (GPT-4o / 画像生成有効) に貼り付け
   - 出力された PNG を同ディレクトリに **指定ファイル名で** 保存

3. **再生成のとき**
   - UI 設計が変わったら designer エージェントを再起動
   - prompt.md が更新される
   - 必要な画像のみ再生成（古い画像は上書き）

## 注意

- 画像ファイルは git にコミットして良い（参照用 low-fi なのでサイズ小）
- 解像度は ChatGPT デフォルトで OK（1024x1024 程度）
- 制作物の正本は `docs/04-ui-design.md` と各 `prompt.md`。画像は補助資料
- prompt.md と画像が食い違っている場合は **prompt.md** を正とする
