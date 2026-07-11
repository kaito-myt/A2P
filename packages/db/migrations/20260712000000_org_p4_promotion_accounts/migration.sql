-- docs/06 P4 増分1 — 販促アカウント台帳（多アカウント運用の土台）
-- org(account_strategist) がアカウント戦略を立案し、必要なアカウントを台帳に pending で積む。
-- 新規作成は create_account=needs_human（規約/KYC）。接続後は connected。

CREATE TABLE "promotion_accounts" (
  "id"             TEXT NOT NULL,
  "channel"        TEXT NOT NULL,
  "handle"         TEXT,
  "niche"          TEXT NOT NULL,
  "target_reader"  TEXT,
  "bio"            TEXT,
  "posting_policy" TEXT,
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "token_enc"      TEXT,
  "token_mask"     TEXT,
  "config_json"    JSONB,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "promotion_accounts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "promotion_accounts_channel_status_idx" ON "promotion_accounts" ("channel", "status");
