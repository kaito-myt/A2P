-- docs/06 P2 — org.execute.dispatch: 承認済 org_tasks の自動実行トグル + cron。
ALTER TABLE "app_settings" ADD COLUMN "org_auto_execute_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "app_settings" ADD COLUMN "org_execute_cron" TEXT NOT NULL DEFAULT '*/15 * * * *';

-- 制作 write タスクが本の制作を起動(kickoff)する際に使うテーマ候補/発注アカウント。
ALTER TABLE "org_tasks" ADD COLUMN "theme_id" TEXT;
ALTER TABLE "org_tasks" ADD COLUMN "account_id" TEXT;
