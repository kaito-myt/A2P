-- docs/06 P3 — 販促のorg統合 + 運用の自己復旧 + 経営の予算ガード
-- org.ops.watch / org.finance.tick の cron 有効化フラグ＋スケジュール。

ALTER TABLE "app_settings"
  ADD COLUMN "org_ops_watch_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "org_ops_watch_cron" TEXT NOT NULL DEFAULT '*/10 * * * *',
  ADD COLUMN "org_finance_tick_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "org_finance_tick_cron" TEXT NOT NULL DEFAULT '0 * * * *';
