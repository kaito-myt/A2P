/**
 * 一回限りのメンテスクリプト: cover_text_check ロールの prompts (4 ジャンル軸) と
 * model_assignment (anthropic/claude-sonnet-4-6) を本番 DB に追加する。
 *
 * 既存行には一切触れず、欠けている cover_text_check 行だけを create する
 * (冪等: 再実行しても重複作成しない)。
 *
 * 使い方:
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-cover-text-check.ts
 */
import { PrismaClient } from './generated/index.js';
import { buildPromptSeeds, buildModelAssignmentSeeds } from './seed.js';

const ROLE = 'cover_text_check';

async function main() {
  const prisma = new PrismaClient();
  let createdPrompts = 0;
  let createdAssignments = 0;
  try {
    // 1. prompts (role × genre)
    const promptSeeds = buildPromptSeeds().filter((s) => s.role === ROLE);
    for (const s of promptSeeds) {
      const existing = await prisma.prompt.findFirst({
        where: { role: s.role, genre: s.genre, version: s.version },
      });
      if (existing) {
        console.log(`prompt exists: ${s.role} genre=${s.genre ?? 'null'} v${s.version}`);
        continue;
      }
      await prisma.prompt.create({
        data: {
          role: s.role,
          genre: s.genre,
          version: s.version,
          body: s.body,
          placeholders_json: s.placeholders_json,
          status: s.status,
          created_by: s.created_by,
        },
      });
      createdPrompts += 1;
      console.log(`prompt created: ${s.role} genre=${s.genre ?? 'null'} v${s.version}`);
    }

    // 2. model assignment (genre=null, active)
    const assignmentSeeds = buildModelAssignmentSeeds().filter((s) => s.role === ROLE);
    for (const s of assignmentSeeds) {
      const existing = await prisma.modelAssignment.findFirst({
        where: { role: s.role, genre: s.genre, status: 'active' },
      });
      if (existing) {
        console.log(`assignment exists: ${s.role} -> ${existing.provider}/${existing.model}`);
        continue;
      }
      await prisma.modelAssignment.create({
        data: {
          role: s.role,
          genre: s.genre,
          provider: s.provider,
          model: s.model,
          status: s.status,
          created_by: s.created_by,
        },
      });
      createdAssignments += 1;
      console.log(`assignment created: ${s.role} -> ${s.provider}/${s.model}`);
    }

    console.log(`done: createdPrompts=${createdPrompts} createdAssignments=${createdAssignments}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
