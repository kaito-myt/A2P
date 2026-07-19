-- F-057 SNS アカウント運用設計: promotion_channel_settings に戦略/画像フィールドを追加。
ALTER TABLE "promotion_channel_settings"
  ADD COLUMN "display_name" TEXT,
  ADD COLUMN "strategy_json" JSONB,
  ADD COLUMN "avatar_key" TEXT,
  ADD COLUMN "banner_key" TEXT,
  ADD COLUMN "strategy_updated_at" TIMESTAMP(3);
