#!/usr/bin/env bash
# KDP 全自動出版ランチャー。既存の下書きをresumeし、保存/出版まで自動で行う。
# アップロード成功を検証してから出版するため、失敗した本は skip され「誤った資産では出版しない」。
#
# 使い方: Git Bash / CI で
#     bash scripts/kdp-auto.sh              # キューの本を全部
#     bash scripts/kdp-auto.sh --limit=1    # 先頭1冊だけ（動作確認用）
#     bash scripts/kdp-auto.sh --dry-run    # 出版直前まで（publishしない）
#
# 秘密情報は Railway から実行時に取得し、ファイルには保存しない。
set -e
cd "$(dirname "$0")/.."

echo "Railway から環境変数を取得中..."
export DBURL=$(railway variables --service Postgres --kv 2>/dev/null | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2- | tr -d '\r')
export LINE_CHANNEL_ACCESS_TOKEN=$(railway variables --service A2P --kv 2>/dev/null | grep '^LINE_CHANNEL_ACCESS_TOKEN=' | cut -d= -f2- | tr -d '\r')
export LINE_USER_ID=$(railway variables --service A2P --kv 2>/dev/null | grep '^LINE_ALLOWED_USER_ID=' | cut -d= -f2- | tr -d '\r')
export R2_ACCOUNT_ID=$(railway variables --service A2P-Worker --kv 2>/dev/null | grep '^R2_ACCOUNT_ID=' | cut -d= -f2- | tr -d '\r')
export R2_ACCESS_KEY_ID=$(railway variables --service A2P-Worker --kv 2>/dev/null | grep '^R2_ACCESS_KEY_ID=' | cut -d= -f2- | tr -d '\r')
export R2_SECRET_ACCESS_KEY=$(railway variables --service A2P-Worker --kv 2>/dev/null | grep '^R2_SECRET_ACCESS_KEY=' | cut -d= -f2- | tr -d '\r')
export R2_BUCKET_NAME=$(railway variables --service A2P-Worker --kv 2>/dev/null | grep '^R2_BUCKET_NAME=' | cut -d= -f2- | tr -d '\r')

if [ -z "$DBURL" ] || [ -z "$R2_BUCKET_NAME" ]; then
  echo "ERROR: 環境変数の取得に失敗しました。railway login / railway link を確認してください。" >&2
  exit 1
fi
echo "OK. 全自動出版を開始します（--auto ${*}）。Chrome が開きます。"
node scripts/kdp-publish.mjs --auto "$@"
