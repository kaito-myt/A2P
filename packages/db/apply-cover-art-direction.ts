/**
 * 一回限り: cover_art_direction ロールの prompts (4 ジャンル軸) と model_assignment を本番に追加。
 * 既存行には触れず欠けている行だけ create する (冪等)。
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-cover-art-direction.ts
 */
import { PrismaClient } from './generated/index.js';
import { buildPromptSeeds, buildModelAssignmentSeeds } from './seed.js';

const ROLE = 'cover_art_direction';

async function main() {
  const prisma = new PrismaClient();
  let cp = 0;
  let ca = 0;
  try {
    for (const s of buildPromptSeeds().filter((x) => x.role === ROLE)) {
      const exists = await prisma.prompt.findFirst({
        where: { role: s.role, genre: s.genre, version: s.version },
      });
      if (exists) { console.log(`prompt exists ${s.genre ?? 'null'}`); continue; }
      await prisma.prompt.create({
        data: {
          role: s.role, genre: s.genre, version: s.version, body: s.body,
          placeholders_json: s.placeholders_json, status: s.status, created_by: s.created_by,
        },
      });
      cp += 1;
      console.log(`prompt created ${s.genre ?? 'null'}`);
    }
    for (const s of buildModelAssignmentSeeds().filter((x) => x.role === ROLE)) {
      const exists = await prisma.modelAssignment.findFirst({
        where: { role: s.role, genre: s.genre, status: 'active' },
      });
      if (exists) { console.log(`assignment exists -> ${exists.provider}/${exists.model}`); continue; }
      await prisma.modelAssignment.create({
        data: { role: s.role, genre: s.genre, provider: s.provider, model: s.model, status: s.status, created_by: s.created_by },
      });
      ca += 1;
      console.log(`assignment created -> ${s.provider}/${s.model}`);
    }
    console.log(`done: prompts=${cp} assignments=${ca}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
