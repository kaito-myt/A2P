-- T-07-09: add r2_archive_threshold_days to app_settings
ALTER TABLE "app_settings"
  ADD COLUMN "r2_archive_threshold_days" INTEGER NOT NULL DEFAULT 365;
