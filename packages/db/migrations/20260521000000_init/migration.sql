-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "pen_name" TEXT NOT NULL,
    "display_name" TEXT,
    "bio" TEXT,
    "target_reader" TEXT,
    "genre_policy_json" JSONB NOT NULL,
    "kdp_credentials_enc" TEXT,
    "kdp_2fa_secret_enc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publishing_plans" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "period_from" TIMESTAMP(3) NOT NULL,
    "period_to" TIMESTAMP(3) NOT NULL,
    "plan_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publishing_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "theme_candidates" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "theme_session_id" TEXT NOT NULL,
    "genre" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "hook" TEXT NOT NULL,
    "target_reader" TEXT,
    "competitors_json" JSONB NOT NULL,
    "signals_json" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rejected_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "theme_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "books" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "theme_id" TEXT,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "asin" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "cost_status" TEXT NOT NULL DEFAULT 'normal',
    "cost_jpy_total" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "prompt_version_ids_json" JSONB NOT NULL,
    "model_assignment_snapshot" JSONB NOT NULL,
    "has_pending_comments" BOOLEAN NOT NULL DEFAULT false,
    "has_blocking_comments" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "done_at" TIMESTAMP(3),

    CONSTRAINT "books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outlines" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "chapters_json" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "reject_note" TEXT,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outlines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapters" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "heading" TEXT NOT NULL,
    "body_md" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "char_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chapters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chapter_revisions" (
    "id" TEXT NOT NULL,
    "chapter_id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body_md" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chapter_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cover_text_proposals" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "band_copy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cover_text_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "covers" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "cover_text_id" TEXT,
    "r2_key" TEXT NOT NULL,
    "artifact_id" TEXT,
    "prompt_used" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'generated',
    "generation_meta_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "covers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kdp_metadata" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "categories" TEXT[],
    "keywords" TEXT[],
    "price_jpy" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kdp_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kdp_submission_progress" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "checklist_state_json" JSONB NOT NULL,
    "auto_submit_status" TEXT,
    "auto_submit_started_at" TIMESTAMP(3),
    "auto_submit_finished_at" TIMESTAMP(3),
    "last_error" TEXT,
    "screenshot_r2_keys" TEXT[],
    "submitted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kdp_submission_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kdp_2fa_codes" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting',
    "code" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMP(3),
    "timeout_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kdp_2fa_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "r2_key" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "graphile_job_id" BIGINT,
    "kind" TEXT NOT NULL,
    "book_id" TEXT,
    "parent_job_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "payload_json" JSONB NOT NULL,
    "result_json" JSONB,
    "error" TEXT,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_plans" (
    "id" TEXT NOT NULL,
    "planned_at" TIMESTAMP(3) NOT NULL,
    "concurrency" INTEGER NOT NULL DEFAULT 5,
    "deadline" TIMESTAMP(3),
    "predicted_cost_jpy" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "kicked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batch_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "batch_plan_items" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "theme_id" TEXT,
    "book_id" TEXT,
    "override_model_assignments_json" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "batch_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_catalog" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_price_per_mtok_usd" DECIMAL(10,6) NOT NULL,
    "output_price_per_mtok_usd" DECIMAL(10,6) NOT NULL,
    "image_price_per_image_usd" DECIMAL(10,6),
    "fx_rate_usd_jpy" DECIMAL(10,4) NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "raw_json" JSONB NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "model_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_assignments" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "genre" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "activated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,

    CONSTRAINT "model_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompts" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "genre" TEXT,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "placeholders_json" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" TEXT NOT NULL,
    "activated_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prompt_proposals" (
    "id" TEXT NOT NULL,
    "source_prompt_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "genre" TEXT,
    "proposed_body" TEXT NOT NULL,
    "diff" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "expected_effect_json" JSONB NOT NULL,
    "sample_output" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "rejection_note" TEXT,
    "rollback_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prompt_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eval_results" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "prompt_version_ids_json" JSONB NOT NULL,
    "score_total" INTEGER NOT NULL,
    "score_breakdown_json" JSONB NOT NULL,
    "judge_comments_json" JSONB NOT NULL,
    "triggered_by" TEXT NOT NULL,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "judged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "eval_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "token_usage" (
    "id" TEXT NOT NULL,
    "book_id" TEXT,
    "theme_session_id" TEXT,
    "job_id" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "image_count" INTEGER NOT NULL DEFAULT 0,
    "unit_price_snapshot" JSONB NOT NULL,
    "cost_jpy" DECIMAL(10,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_records" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "year_month" TEXT NOT NULL,
    "royalty_jpy" INTEGER NOT NULL,
    "review_count" INTEGER NOT NULL DEFAULT 0,
    "avg_stars" DECIMAL(3,2),
    "bsr" INTEGER,
    "source" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "read_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "target_kind" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "before_json" JSONB,
    "after_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revision_comments" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "target_kind" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "range_json" JSONB,
    "body" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "run_id" TEXT,
    "application_result_json" JSONB,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMP(3),

    CONSTRAINT "revision_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revision_runs" (
    "id" TEXT NOT NULL,
    "triggered_by" TEXT NOT NULL,
    "triggered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'queued',
    "book_ids_json" JSONB NOT NULL,
    "comment_ids_json" JSONB NOT NULL,
    "result_summary_json" JSONB,
    "error" TEXT,

    CONSTRAINT "revision_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "book_locks" (
    "book_id" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "acquired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "book_locks_pkey" PRIMARY KEY ("book_id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "notification_email_to" TEXT NOT NULL,
    "notification_kinds_json" JSONB NOT NULL,
    "cost_per_book_warn_jpy" INTEGER NOT NULL DEFAULT 500,
    "cost_per_book_pause_jpy" INTEGER NOT NULL DEFAULT 750,
    "monthly_cost_yellow_jpy" INTEGER NOT NULL DEFAULT 40000,
    "monthly_cost_orange_jpy" INTEGER NOT NULL DEFAULT 47500,
    "monthly_cost_red_jpy" INTEGER NOT NULL DEFAULT 50000,
    "catalog_price_change_threshold" DECIMAL(4,3) NOT NULL DEFAULT 0.10,
    "prompt_auto_approval_enabled" BOOLEAN NOT NULL DEFAULT false,
    "prompt_auto_approval_rollback_h" INTEGER NOT NULL DEFAULT 24,
    "sales_auto_fetch_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sales_auto_fetch_cron" TEXT NOT NULL DEFAULT '0 17 * * *',
    "kdp_submit_timeout_minutes" INTEGER NOT NULL DEFAULT 10,
    "kdp_submit_retry_count" INTEGER NOT NULL DEFAULT 2,
    "job_log_retention_days" INTEGER NOT NULL DEFAULT 90,
    "ai_disclosure_text" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "accounts_status_idx" ON "accounts"("status");

-- CreateIndex
CREATE INDEX "publishing_plans_account_period_idx" ON "publishing_plans"("account_id", "period_from");

-- CreateIndex
CREATE INDEX "theme_candidates_account_status_idx" ON "theme_candidates"("account_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "theme_candidates_session_idx" ON "theme_candidates"("theme_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "books_asin_key" ON "books"("asin");

-- CreateIndex
CREATE INDEX "books_account_status_idx" ON "books"("account_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "books_status_blocking_idx" ON "books"("status", "has_blocking_comments");

-- CreateIndex
CREATE INDEX "books_cost_status_idx" ON "books"("cost_status");

-- CreateIndex
CREATE UNIQUE INDEX "outlines_book_id_key" ON "outlines"("book_id");

-- CreateIndex
CREATE INDEX "outlines_status_idx" ON "outlines"("status");

-- CreateIndex
CREATE INDEX "chapters_book_status_idx" ON "chapters"("book_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "chapters_book_index_key" ON "chapters"("book_id", "index");

-- CreateIndex
CREATE INDEX "chapter_revisions_chapter_version_idx" ON "chapter_revisions"("chapter_id", "version" DESC);

-- CreateIndex
CREATE INDEX "cover_text_proposals_book_status_idx" ON "cover_text_proposals"("book_id", "status");

-- CreateIndex
CREATE INDEX "covers_book_status_idx" ON "covers"("book_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "kdp_metadata_book_id_key" ON "kdp_metadata"("book_id");

-- CreateIndex
CREATE UNIQUE INDEX "kdp_submission_progress_book_id_key" ON "kdp_submission_progress"("book_id");

-- CreateIndex
CREATE UNIQUE INDEX "kdp_2fa_codes_job_id_key" ON "kdp_2fa_codes"("job_id");

-- CreateIndex
CREATE INDEX "kdp_2fa_codes_status_timeout_idx" ON "kdp_2fa_codes"("status", "timeout_at");

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_r2_key_key" ON "artifacts"("r2_key");

-- CreateIndex
CREATE INDEX "artifacts_book_kind_idx" ON "artifacts"("book_id", "kind");

-- CreateIndex
CREATE INDEX "jobs_status_kind_idx" ON "jobs"("status", "kind", "created_at" DESC);

-- CreateIndex
CREATE INDEX "jobs_book_kind_idx" ON "jobs"("book_id", "kind");

-- CreateIndex
CREATE INDEX "batch_plans_status_planned_idx" ON "batch_plans"("status", "planned_at");

-- CreateIndex
CREATE INDEX "batch_plan_items_batch_idx" ON "batch_plan_items"("batch_id");

-- CreateIndex
CREATE INDEX "model_catalog_current_idx" ON "model_catalog"("is_current", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "model_catalog_provider_model_time_key" ON "model_catalog"("provider", "model", "fetched_at");

-- CreateIndex
CREATE INDEX "model_assignments_role_genre_status_idx" ON "model_assignments"("role", "genre", "status");

-- CreateIndex
CREATE INDEX "model_assignments_role_genre_time_idx" ON "model_assignments"("role", "genre", "activated_at" DESC);

-- CreateIndex
CREATE INDEX "prompts_role_genre_status_idx" ON "prompts"("role", "genre", "status");

-- CreateIndex
CREATE INDEX "prompts_role_genre_ver_idx" ON "prompts"("role", "genre", "version" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "prompts_role_genre_version_key" ON "prompts"("role", "genre", "version");

-- CreateIndex
CREATE INDEX "prompt_proposals_status_idx" ON "prompt_proposals"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "eval_results_book_time_idx" ON "eval_results"("book_id", "judged_at" DESC);

-- CreateIndex
CREATE INDEX "eval_results_time_idx" ON "eval_results"("judged_at" DESC);

-- CreateIndex
CREATE INDEX "token_usage_book_time_idx" ON "token_usage"("book_id", "created_at");

-- CreateIndex
CREATE INDEX "token_usage_session_idx" ON "token_usage"("theme_session_id");

-- CreateIndex
CREATE INDEX "token_usage_provider_model_idx" ON "token_usage"("provider", "model", "created_at");

-- CreateIndex
CREATE INDEX "token_usage_role_idx" ON "token_usage"("role", "created_at");

-- CreateIndex
CREATE INDEX "token_usage_time_idx" ON "token_usage"("created_at" DESC);

-- CreateIndex
CREATE INDEX "sales_records_month_idx" ON "sales_records"("year_month");

-- CreateIndex
CREATE UNIQUE INDEX "sales_records_book_month_key" ON "sales_records"("book_id", "year_month");

-- CreateIndex
CREATE INDEX "alerts_resolved_time_idx" ON "alerts"("resolved_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "alerts_kind_time_idx" ON "alerts"("kind", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_time_idx" ON "audit_log"("created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_target_idx" ON "audit_log"("target_kind", "target_id");

-- CreateIndex
CREATE INDEX "revision_comments_book_status_idx" ON "revision_comments"("book_id", "status", "priority");

-- CreateIndex
CREATE INDEX "revision_comments_status_time_idx" ON "revision_comments"("status", "created_at");

-- CreateIndex
CREATE INDEX "revision_comments_target_idx" ON "revision_comments"("target_kind", "target_id");

-- CreateIndex
CREATE INDEX "revision_runs_status_time_idx" ON "revision_runs"("status", "triggered_at" DESC);

-- CreateIndex
CREATE INDEX "book_locks_expires_idx" ON "book_locks"("expires_at");

-- AddForeignKey
ALTER TABLE "publishing_plans" ADD CONSTRAINT "publishing_plans_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "theme_candidates" ADD CONSTRAINT "theme_candidates_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "books" ADD CONSTRAINT "books_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "books" ADD CONSTRAINT "books_theme_id_fkey" FOREIGN KEY ("theme_id") REFERENCES "theme_candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outlines" ADD CONSTRAINT "outlines_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter_revisions" ADD CONSTRAINT "chapter_revisions_chapter_id_fkey" FOREIGN KEY ("chapter_id") REFERENCES "chapters"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chapter_revisions" ADD CONSTRAINT "chapter_revisions_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cover_text_proposals" ADD CONSTRAINT "cover_text_proposals_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "covers" ADD CONSTRAINT "covers_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kdp_metadata" ADD CONSTRAINT "kdp_metadata_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kdp_submission_progress" ADD CONSTRAINT "kdp_submission_progress_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_parent_job_id_fkey" FOREIGN KEY ("parent_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_plan_items" ADD CONSTRAINT "batch_plan_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batch_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "batch_plan_items" ADD CONSTRAINT "batch_plan_items_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_proposals" ADD CONSTRAINT "prompt_proposals_source_prompt_id_fkey" FOREIGN KEY ("source_prompt_id") REFERENCES "prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_records" ADD CONSTRAINT "sales_records_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revision_comments" ADD CONSTRAINT "revision_comments_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revision_comments" ADD CONSTRAINT "revision_comments_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "revision_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revision_runs" ADD CONSTRAINT "revision_runs_triggered_by_fkey" FOREIGN KEY ("triggered_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

