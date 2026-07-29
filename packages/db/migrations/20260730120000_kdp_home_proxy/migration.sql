-- F-038 補強: KDP アクセスを自宅回線(住宅IP)経由にするトンネルプロキシ設定。
-- Railway のデータセンター IP だと Amazon ログインが anti-bot に当たるため、自宅PCの
-- オーケストレータ(scripts/kdp-home-proxy.mjs)が ngrok 公開アドレスを kdp_proxy_url に
-- heartbeat 公開し、worker はそれを Playwright の HTTP プロキシとして使う。
ALTER TABLE "app_settings"
  ADD COLUMN "kdp_proxy_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "kdp_proxy_url" TEXT,
  ADD COLUMN "kdp_proxy_updated_at" TIMESTAMP(3);
