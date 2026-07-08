-- CreateTable: 所有ブログ記事 (F-052b)
CREATE TABLE "blog_posts" (
    "id" TEXT NOT NULL,
    "book_id" TEXT,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body_md" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'published',
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blog_posts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "blog_posts_slug_key" ON "blog_posts"("slug");
CREATE INDEX "blog_posts_status_published_at_idx" ON "blog_posts"("status", "published_at" DESC);
