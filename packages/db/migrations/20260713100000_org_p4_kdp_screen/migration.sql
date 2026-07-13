-- docs/06 P4 増分3 — KDP 公開の事前スクリーニング（ゲート付き・既定OFF）
-- 合格書籍のみ自動で承認済(公開クリア)へ。実際の外部入稿は Phase 3 まで人手のまま。

ALTER TABLE "app_settings"
  ADD COLUMN "org_kdp_auto_publish_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "org_kdp_screen_cron" TEXT NOT NULL DEFAULT '30 * * * *',
  ADD COLUMN "org_kdp_min_quality" INTEGER NOT NULL DEFAULT 70,
  ADD COLUMN "org_kdp_min_price_jpy" INTEGER NOT NULL DEFAULT 250,
  ADD COLUMN "org_kdp_max_price_jpy" INTEGER NOT NULL DEFAULT 1250;
