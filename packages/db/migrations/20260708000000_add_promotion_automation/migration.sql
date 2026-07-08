-- AlterTable: AppSettings — 販促自動運用トグル (F-052)
ALTER TABLE "app_settings" ADD COLUMN "promo_auto_on_publish_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "app_settings" ADD COLUMN "promo_auto_post_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "app_settings" ADD COLUMN "promo_dispatch_cron" TEXT NOT NULL DEFAULT '*/30 * * * *';

-- CreateTable: 販促チャンネル設定 (SNS / note / blog)
CREATE TABLE "promotion_channel_settings" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "auto_enabled" BOOLEAN NOT NULL DEFAULT false,
    "handle" TEXT,
    "token_enc" TEXT,
    "token_mask" TEXT,
    "config_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotion_channel_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "promotion_channel_settings_channel_key" ON "promotion_channel_settings"("channel");

-- CreateTable: 販促投稿キュー
CREATE TABLE "promotion_posts" (
    "id" TEXT NOT NULL,
    "book_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "external_url" TEXT,
    "error" TEXT,
    "posted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "promotion_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "promotion_posts_status_scheduled_for_idx" ON "promotion_posts"("status", "scheduled_for");
CREATE INDEX "promotion_posts_book_id_idx" ON "promotion_posts"("book_id");
CREATE INDEX "promotion_posts_channel_status_idx" ON "promotion_posts"("channel", "status");

-- AddForeignKey
ALTER TABLE "promotion_posts" ADD CONSTRAINT "promotion_posts_book_id_fkey" FOREIGN KEY ("book_id") REFERENCES "books"("id") ON DELETE CASCADE ON UPDATE CASCADE;
