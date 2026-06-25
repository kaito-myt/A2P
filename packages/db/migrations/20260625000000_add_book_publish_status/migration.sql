-- Book に Amazon KDP 出版ステータス (手動管理) を追加。
-- unlisted = 未対応 / published = 出版済み
ALTER TABLE "books" ADD COLUMN "publish_status" TEXT NOT NULL DEFAULT 'unlisted';
CREATE INDEX "books_publish_status_idx" ON "books" ("publish_status");
