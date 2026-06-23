/**
 * 本実装プロンプトを DB の active 行へ反映する一回限りのメンテスクリプト。
 *
 * seed.ts の buildPromptSeeds() が生成する最新 body を、既存の status='active'
 * プロンプト (role+genre) に上書きする。version は据え置き (履歴を増やさない)。
 *
 * 使い方:
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-prompts.ts
 *
 * 注意: prompts テーブルのみ更新する (users / model_assignments 等には触れない)。
 */
import { PrismaClient } from './generated/index.js';
import { buildPromptSeeds } from './seed.js';

async function main() {
  const prisma = new PrismaClient();
  const seeds = buildPromptSeeds();
  let updated = 0;
  let missing = 0;
  try {
    for (const s of seeds) {
      const res = await prisma.prompt.updateMany({
        where: { role: s.role, genre: s.genre, status: 'active' },
        data: { body: s.body, placeholders_json: s.placeholders_json },
      });
      if (res.count === 0) {
        console.warn(`no active row for role=${s.role} genre=${s.genre ?? 'null'}`);
        missing += 1;
      } else {
        updated += res.count;
      }
    }
    console.log(`done: updated=${updated} missing=${missing} (seeds=${seeds.length})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
