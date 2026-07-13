-- docs/06 P4 増分4 — 勝ちパターン台帳（方針の自動学習）
-- org.plan が実績から抽出した「効いている型」を蓄積し CEO の意思決定に供給する。singleton。

CREATE TABLE "org_playbook" (
  "id"            TEXT NOT NULL DEFAULT 'singleton',
  "patterns_json" JSONB NOT NULL,
  "updated_at"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "org_playbook_pkey" PRIMARY KEY ("id")
);
