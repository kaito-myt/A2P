/**
 * 一回限り: ジャンル方針を「役割プロンプト 1 本 + 実行時注入」方式へ移行する。
 *
 * 背景: ジャンルが 29 種に増えたが、旧設計は「役割 × ジャンル」の全文プロンプトを
 * DB に量産していた (business/practical/self_help のみ)。実際に既定と中身が違うのは
 * 6 役 (marketer/marketer_plan/writer/editor/thumbnail_text/thumbnail_image) の
 * 「ジャンル方針 1 行」だけで、残りは既定の完全な重複だった。
 *
 * 本スクリプトは:
 *   1. 上記 6 役の active な既定 (genre=null) 本文を `{genre_guidance}` プレースホルダ版
 *      (= buildPromptSeeds の最新本文) に差し替える。方針は実行時に prompt-loader が
 *      contracts/genres.ts から注入する (全 29 ジャンル対応)。
 *   2. business/practical/self_help のジャンル別 active 行を **archive** する
 *      (= 全ジャンルが「既定 + 注入」に一本化される)。ジャンル別に上書きしたい場合は
 *      UI から個別 Prompt を追加すればフォールバック規約でそれが優先される。
 *
 * 冪等: 既に移行済みなら差分ゼロ。archive も active のみ対象。
 *
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-genre-guidance.ts
 */
import { PrismaClient } from './generated/index.js';
import { buildPromptSeeds } from './seed.js';

/** 既定本文が実際にジャンルで変わる (＝ {genre_guidance} を埋めた) 役割。 */
const VARYING_ROLES = [
  'marketer',
  'marketer_plan',
  'writer',
  'editor',
  'thumbnail_text',
  'thumbnail_image',
] as const;

const LEGACY_GENRES = ['practical', 'business', 'self_help'];

async function main() {
  const prisma = new PrismaClient();
  try {
    const seeds = buildPromptSeeds(); // 役割ごと genre=null の最新本文
    let bodyUpdated = 0;

    // 1. 6 役の active 既定本文を {genre_guidance} 版へ差し替え (差分がある場合のみ)。
    for (const role of VARYING_ROLES) {
      const seed = seeds.find((s) => s.role === role && s.genre === null);
      if (!seed) {
        console.warn(`WARN: no default seed for role=${role}`);
        continue;
      }
      const res = await prisma.prompt.updateMany({
        where: { role, genre: null, status: 'active' },
        data: { body: seed.body },
      });
      bodyUpdated += res.count;
      console.log(`default body updated: role=${role} rows=${res.count}`);
    }

    // 2. business/practical/self_help のジャンル別 active 行を archive。
    const archived = await prisma.prompt.updateMany({
      where: { genre: { in: LEGACY_GENRES }, status: 'active' },
      data: { status: 'archived', archived_at: new Date() },
    });
    console.log(`legacy genre-specific prompts archived: rows=${archived.count}`);

    console.log(`done: ${bodyUpdated} default bodies updated, ${archived.count} genre rows archived`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
