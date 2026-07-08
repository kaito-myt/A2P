-- docs/06 — 組織エージェント (CEO → 本部長 → 担当者 ＋ 全社ToDoバックログ)
-- token_usage.org_task_id / org_objectives / org_tasks / AppSettings org flags

-- 1. token_usage: 組織タスク別コスト集計キー
ALTER TABLE "token_usage" ADD COLUMN "org_task_id" TEXT;
CREATE INDEX "token_usage_org_task_idx" ON "token_usage" ("org_task_id");

-- 2. AppSettings: CEOティックの自動起動フラグ + cron
ALTER TABLE "app_settings" ADD COLUMN "org_auto_plan_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "app_settings" ADD COLUMN "org_plan_cron" TEXT NOT NULL DEFAULT '0 20 * * *';

-- 3. org_objectives (CEO の方針)
CREATE TABLE "org_objectives" (
  "id" TEXT NOT NULL,
  "period_label" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body_json" JSONB NOT NULL,
  "budget_jpy" INTEGER,
  "budget_allocation_json" JSONB,
  "status" TEXT NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "org_objectives_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "org_objectives_status_time_idx" ON "org_objectives" ("status", "created_at" DESC);

-- 4. org_tasks (全社ToDoバックログ)
CREATE TABLE "org_tasks" (
  "id" TEXT NOT NULL,
  "objective_id" TEXT,
  "parent_id" TEXT,
  "division" TEXT NOT NULL,
  "book_id" TEXT,
  "owner_role" TEXT NOT NULL,
  "assignee_role" TEXT NOT NULL,
  "channel" TEXT,
  "account_ref" TEXT,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "instruction" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'proposed',
  "priority" TEXT NOT NULL DEFAULT 'should',
  "depends_on" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "scheduled_for" TIMESTAMP(3),
  "cost_jpy" DECIMAL(10,4),
  "result_json" JSONB,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "done_at" TIMESTAMP(3),
  CONSTRAINT "org_tasks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "org_tasks_status_sched_idx" ON "org_tasks" ("status", "scheduled_for");
CREATE INDEX "org_tasks_division_status_idx" ON "org_tasks" ("division", "status");
CREATE INDEX "org_tasks_book_idx" ON "org_tasks" ("book_id");
CREATE INDEX "org_tasks_assignee_status_idx" ON "org_tasks" ("assignee_role", "status");
CREATE INDEX "org_tasks_objective_idx" ON "org_tasks" ("objective_id");

ALTER TABLE "org_tasks" ADD CONSTRAINT "org_tasks_objective_id_fkey"
  FOREIGN KEY ("objective_id") REFERENCES "org_objectives" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "org_tasks" ADD CONSTRAINT "org_tasks_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "org_tasks" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "org_tasks" ADD CONSTRAINT "org_tasks_book_id_fkey"
  FOREIGN KEY ("book_id") REFERENCES "books" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
