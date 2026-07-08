/**
 * 一回限り: 本番の active な cover_art_direction プロンプト本文を v2 (売れ筋表紙リサーチ駆動)
 * に更新する。id/version/status は変えず body だけ差し替える (単一運営者向けの手動改訂)。
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-cover-art-direction-refresh.ts
 */
import { PrismaClient } from './generated/index.js';
import { buildPromptSeeds } from './seed.js';

const ROLE = 'cover_art_direction';

async function main() {
  const prisma = new PrismaClient();
  let n = 0;
  try {
    for (const s of buildPromptSeeds().filter((x) => x.role === ROLE)) {
      const res = await prisma.prompt.updateMany({
        where: { role: ROLE, genre: s.genre, status: 'active' },
        data: { body: s.body },
      });
      n += res.count;
      console.log(`updated genre=${s.genre ?? 'null'} rows=${res.count}`);
    }
    console.log(`done: updated ${n} active cover_art_direction prompts`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
