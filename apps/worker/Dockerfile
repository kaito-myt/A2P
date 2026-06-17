# syntax=docker/dockerfile:1.7
#
# apps/worker — graphile-worker プロセス
#
# Railway は Dockerfile が apps/worker 配下にある場合、これを使ってイメージをビルドする。
# 同梱物:
#   - Node 22 (公式 slim)
#   - pnpm 9 (corepack 経由で固定)
#   - postgresql-client 16 (`pg_dump` 必須 / R-12 緩和: archive.db.backup タスク)
#
# Phase 3 で Playwright + Chromium / sharp 用の libvips を追加予定 (本ファイルにコメントだけ残す)。

FROM node:22-bookworm-slim AS base

# pg_dump (PostgreSQL 16 系) を `apt-get` で導入する。Debian bookworm 標準は 15 系なので、
# PostgreSQL APT リポジトリを追加して 16 系を pin する。これは Railway Postgres (16) と
# サーババージョン整合を保つため (`pg_dump` < サーバ時に互換警告が出る)。
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       gnupg \
       lsb-release \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-16 \
  && rm -rf /var/lib/apt/lists/*

# Phase 3 で追加予定 (本タスクではコメントのみ):
#   libvips42       # sharp 後処理 (F-014)
#   chromium + deps # Playwright (F-041)

# corepack で pnpm@9 を有効化
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# ---------------------------------------------------------------------------
# deps ステージ: pnpm install を キャッシュ最適化のため分離
# ---------------------------------------------------------------------------
FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/agents/package.json packages/agents/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/notify/package.json packages/notify/package.json
COPY packages/crypto/package.json packages/crypto/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/output/image/package.json packages/output/image/package.json
COPY packages/output/pdf/package.json packages/output/pdf/package.json
COPY packages/output/word/package.json packages/output/word/package.json

# `--ignore-scripts` は Prisma などの postinstall を抑止 (この段階では generate に必要な
# schema.prisma がまだコピーされていないため)。
RUN pnpm install --frozen-lockfile --ignore-scripts

# ---------------------------------------------------------------------------
# build ステージ: ソース全体をコピーして tsc / prisma generate
# ---------------------------------------------------------------------------
FROM deps AS build

COPY . .
RUN pnpm --filter @a2p/db generate

# ---------------------------------------------------------------------------
# runtime ステージ: 最終イメージ
# ---------------------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app /app

# graphile-worker は tsx 経由で TS を直接実行する (apps/worker/package.json scripts.start)。
# 本番でも tsx を採用するのは Phase 1 の単純化のため。Phase 2 以降で esbuild バンドルに切替予定。
CMD ["pnpm", "--filter", "@a2p/worker", "start"]
