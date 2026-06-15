-- CreateTable
CREATE TABLE "sales_fetch_runs" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "year_month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "records_upserted" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "sales_fetch_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_fetch_runs_account_time_idx" ON "sales_fetch_runs"("account_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "sales_fetch_runs_status_time_idx" ON "sales_fetch_runs"("status", "started_at" DESC);

-- AddForeignKey
ALTER TABLE "sales_fetch_runs" ADD CONSTRAINT "sales_fetch_runs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
