-- docs/05 §3 / F-051・F-052 / T-02-13
-- ApiCredential: UI 経由で登録される LLM プロバイダ API キーの暗号化保存。
-- env (.env.local) は DB 未登録時のフォールバック。

CREATE TABLE "api_credentials" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "key_enc" TEXT NOT NULL,
    "key_mask" TEXT NOT NULL,
    "set_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "set_by" TEXT NOT NULL,
    "last_tested_at" TIMESTAMP(3),
    "last_test_result_json" JSONB,

    CONSTRAINT "api_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "api_credentials_provider_key" ON "api_credentials"("provider");
