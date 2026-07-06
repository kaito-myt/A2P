-- CreateTable
CREATE TABLE "author_names" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_kana" TEXT,
    "name_romaji" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "author_names_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label_names" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "label_names_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "author_names_status_name_idx" ON "author_names"("status", "name");

-- CreateIndex
CREATE INDEX "label_names_status_name_idx" ON "label_names"("status", "name");

-- AlterTable
ALTER TABLE "theme_candidates" ADD COLUMN "author_name_id" TEXT,
ADD COLUMN "label_name_id" TEXT;

-- CreateIndex
CREATE INDEX "theme_candidates_author_name_idx" ON "theme_candidates"("author_name_id");

-- CreateIndex
CREATE INDEX "theme_candidates_label_name_idx" ON "theme_candidates"("label_name_id");

-- AddForeignKey
ALTER TABLE "theme_candidates" ADD CONSTRAINT "theme_candidates_author_name_id_fkey" FOREIGN KEY ("author_name_id") REFERENCES "author_names"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "theme_candidates" ADD CONSTRAINT "theme_candidates_label_name_id_fkey" FOREIGN KEY ("label_name_id") REFERENCES "label_names"("id") ON DELETE SET NULL ON UPDATE CASCADE;
