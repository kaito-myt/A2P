-- CreateTable
CREATE TABLE "promotion_plans" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "plan_json" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotion_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "promotion_plans_book_id_key" ON "promotion_plans"("book_id");

-- AddForeignKey
ALTER TABLE "promotion_plans" ADD CONSTRAINT "promotion_plans_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;
