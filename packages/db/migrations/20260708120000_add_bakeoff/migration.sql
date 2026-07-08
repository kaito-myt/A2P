-- CreateTable: モデル・バエオフ (F-053)
CREATE TABLE "bakeoff_runs" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "genre" TEXT,
    "input_label" TEXT NOT NULL,
    "input_json" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bakeoff_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bakeoff_runs_role_created_at_idx" ON "bakeoff_runs"("role", "created_at" DESC);

CREATE TABLE "bakeoff_results" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "output_text" TEXT,
    "quality_score" INTEGER,
    "rank" INTEGER,
    "rationale" TEXT,
    "cost_jpy" DECIMAL(10,4),
    "latency_ms" INTEGER,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bakeoff_results_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bakeoff_results_run_id_idx" ON "bakeoff_results"("run_id");

ALTER TABLE "bakeoff_results" ADD CONSTRAINT "bakeoff_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "bakeoff_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
