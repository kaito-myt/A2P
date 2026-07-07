/**
 * 一回限り: 本番の active な marketer プロンプト本文を最新版 (Amazon 売れ筋リサーチ強化) に更新する。
 * prompt の id/version/status は変えず body だけ差し替える (単一運営者向けの手動改訂)。
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-marketer-refresh.ts
 */
import { PrismaClient } from './generated/index.js';
import { buildPromptSeeds } from './seed.js';

const ROLE = 'marketer';

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
    console.log(`done: updated ${n} active marketer prompts`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
