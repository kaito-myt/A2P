-- T-11-06: add ab_distribution_json to app_settings for A/B prompt distribution
ALTER TABLE "app_settings"
  ADD COLUMN "ab_distribution_json" JSONB;
