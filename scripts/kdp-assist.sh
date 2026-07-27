#!/usr/bin/env bash
# KDP 準自動出版ランチャー（運営者が自分のターミナルで実行し、ブラウザを直接操作する用）。
#
# 使い方: Git Bash で C:/DEV/A2P に移動して
#     bash scripts/kdp-assist.sh
#   → Chrome が開き、既存の下書きを1冊ずつ resume して各ステップを自動入力する。
#     「保存して続行 / 出版」は自分で押す（各ステップ最大30分待機）。
#
# 秘密情報は Railway から実行時に取得し、ファイルには保存しない。
# 前提: railway CLI がこの端末でログイン済み & プロジェクト link 済み。
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
echo "OK. 準自動出版を開始します（--assist ${*}）。Chrome が開きます。"
node scripts/kdp-publish.mjs --assist "$@"
