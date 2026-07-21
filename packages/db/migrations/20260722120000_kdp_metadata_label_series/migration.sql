-- F-020c KDP 入稿: レーベル読み(カナ/ローマ字) + シリーズ名。
ALTER TABLE "kdp_metadata"
  ADD COLUMN "label_kana" TEXT,
  ADD COLUMN "label_romaji" TEXT,
  ADD COLUMN "series_name" TEXT;
