-- F-059 育成(価値提供)投稿: kind 列追加 + book_id を null 可に。
ALTER TABLE "promotion_posts" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'promo';
ALTER TABLE "promotion_posts" ALTER COLUMN "book_id" DROP NOT NULL;
