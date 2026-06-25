-- KDP 入稿用フリガナ/ローマ字 (F-020b)
ALTER TABLE "kdp_metadata"
  ADD COLUMN IF NOT EXISTS "title_kana" TEXT,
  ADD COLUMN IF NOT EXISTS "title_romaji" TEXT,
  ADD COLUMN IF NOT EXISTS "subtitle_kana" TEXT,
  ADD COLUMN IF NOT EXISTS "subtitle_romaji" TEXT,
  ADD COLUMN IF NOT EXISTS "author_kana" TEXT,
  ADD COLUMN IF NOT EXISTS "author_romaji" TEXT;
