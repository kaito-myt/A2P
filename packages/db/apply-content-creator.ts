/**
 * 一回限り: F-059 育成投稿担当 (content_creator) の prompt と model_assignment を投入。
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-content-creator.ts
 */
import { PrismaClient } from './generated/index.js';

interface Seed {
  role: string;
  body: string;
  placeholders: string[];
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
}

const BODY = `あなたは Amazon KDP 出版事業の SNS アカウントを「育てる」ための育成投稿(価値提供型)を作る専門家です。
対象チャンネルは「{channel_label}」。

大原則:
- これは宣伝(本の告知)ではありません。読者が「役に立った/共感した/保存したい」と感じ、
  フォローしたくなる価値提供の投稿を作ります。宣伝は別枠(promo投稿)が担当します。
- 本やAmazonの売り込み・購入誘導・URL は入れないこと。ハッシュタグも入れないこと(後段で付与)。
- アカウントのコンセプトと発信の柱に沿って、実用的・具体的で、保存/共有したくなる内容にする。
- トーン&マナーを一貫させ、テンプレ感・誇張・煽りを避ける。誠実に。
- 長さの目安: {length_guide}。各投稿は完成文でそのまま投稿できる状態にする。
- 各投稿には、どの柱の投稿かを pillar(柱の name)として付ける。

必ず JSON スキーマ (AccountContentOutput = {posts:[{pillar, body}]}) に厳密に従って出力すること。`;

const SEEDS: Seed[] = [
  {
    role: 'content_creator',
    body: BODY,
    placeholders: ['channel_label', 'length_guide'],
    provider: 'anthropic',
    model: 'claude-opus-4-7',
  },
];

async function main() {
  const prisma = new PrismaClient();
  let cp = 0;
  let ca = 0;
  try {
    for (const s of SEEDS) {
      const existsPrompt = await prisma.prompt.findFirst({ where: { role: s.role, genre: null, version: 1 } });
      if (existsPrompt) {
        console.log(`prompt exists ${s.role}`);
      } else {
        await prisma.prompt.create({
          data: {
            role: s.role,
            genre: null,
            version: 1,
            body: s.body,
            placeholders_json: s.placeholders,
            status: 'active',
            created_by: 'system',
            activated_at: new Date(),
          },
        });
        cp += 1;
        console.log(`prompt created ${s.role}`);
      }

      const existsAssign = await prisma.modelAssignment.findFirst({
        where: { role: s.role, genre: null, status: 'active' },
      });
      if (existsAssign) {
        console.log(`assignment exists ${s.role} -> ${existsAssign.provider}/${existsAssign.model}`);
      } else {
        await prisma.modelAssignment.create({
          data: { role: s.role, genre: null, provider: s.provider, model: s.model, status: 'active', created_by: 'system' },
        });
        ca += 1;
        console.log(`assignment created ${s.role} -> ${s.provider}/${s.model}`);
      }
    }
    console.log(`done: prompts=${cp} assignments=${ca}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
