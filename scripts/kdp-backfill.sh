#!/usr/bin/env bash
# KDP 本棚から実 ASIN・実価格を取得し DB に backfill するランチャー (READ-ONLY)。
# 使い方: bash scripts/kdp-backfill.sh [--dry-run] [--all]
set -e
cd "$(dirname "$0")/.."
echo "Railway から環境変数を取得中..."
export DBURL=$(railway variables --service Postgres --kv 2>/dev/null | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2- | tr -d '\r')
export AMAZON_EMAIL=$(railway variables --service A2P-Worker --kv 2>/dev/null | grep '^AMAZON_EMAIL=' | cut -d= -f2- | tr -d '\r')
export AMAZON_PASSWORD=$(railway variables --service A2P-Worker --kv 2>/dev/null | grep '^AMAZON_PASSWORD=' | cut -d= -f2- | tr -d '\r')
if [ -z "$DBURL" ]; then echo "ERROR: DBURL 取得失敗 (railway login 確認)" >&2; exit 1; fi
echo "OK. 本棚 backfill を開始します ($*)。Chrome が開きます。"
node scripts/kdp-backfill-asin.mjs "$@"
