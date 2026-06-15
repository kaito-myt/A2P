-- docs/05 §3 / B-04 / T-02-08
-- AppSettings.latest_fx_rate: fx.fetch (B-04) が日次更新する USD/JPY 為替レート。
-- catalog.fetch (T-02-09) が `fx_rate_usd_jpy` として参照する。初回 fetch 前は NULL。

ALTER TABLE "app_settings"
  ADD COLUMN "latest_fx_rate" DECIMAL(10,4);
