-- docs/05 §3.2 パーシャル UNIQUE
-- Prisma DSL は WHERE 付き UNIQUE をネイティブサポートしないため、init の後段で手書きする。

-- ModelAssignment: 役割 × ジャンル × status='active' は 1 行のみ
CREATE UNIQUE INDEX "model_assignments_role_genre_active_key"
  ON "model_assignments" ("role", COALESCE("genre", ''))
  WHERE "status" = 'active';

-- Prompt: 役割 × ジャンル × status='active' は 1 行のみ
CREATE UNIQUE INDEX "prompts_role_genre_active_key"
  ON "prompts" ("role", COALESCE("genre", ''))
  WHERE "status" = 'active';
