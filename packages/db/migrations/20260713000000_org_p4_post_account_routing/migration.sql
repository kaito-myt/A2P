-- docs/06 P4 増分2 — 多アカウント投稿ルーティング
-- promotion_posts に投稿先の台帳アカウント参照を追加。null なら channel 既定設定を使う。

ALTER TABLE "promotion_posts" ADD COLUMN "account_id" TEXT;

CREATE INDEX "promotion_posts_account_id_idx" ON "promotion_posts" ("account_id");

ALTER TABLE "promotion_posts"
  ADD CONSTRAINT "promotion_posts_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "promotion_accounts" ("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
