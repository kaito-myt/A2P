-- T-07-03: monthly budget exceeded flag + force continue toggle
ALTER TABLE "app_settings"
  ADD COLUMN "monthly_budget_exceeded" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "force_continue" BOOLEAN NOT NULL DEFAULT false;
