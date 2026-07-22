/**
 * 一回限り: F-061 日次投稿見直し担当 (content_optimizer) の prompt と model_assignment を投入。
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-content-optimizer.ts
 */
import { PrismaClient } from './generated/index.js';

interface Seed {
  role: string;
  body: string;
  placeholders: string[];
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
}

const BODY = `あなたは Amazon KDP 出版事業の SNS 予定投稿を、公開前に見直して改善する編集者です。
対象チャンネルは「{channel_label}」。

役割:
- 予定投稿(scheduled)の本文を、エンゲージメント(反応/保存/フォロー)と最終的な本の売上に
  つながるよう推敲する。毎日1回の定期見直し。
- 冒頭1行でスクロールを止めるフック(問い/意外な事実/明確なベネフィット)を効かせる。
- 具体的で、保存/共有したくなる情報に整える。誇張・煽り・テンプレ感は避け、誠実に。

厳守:
- kind='promo'(販促)は、本の魅力と購入導線(『KU会員は無料』等)・URL を必ず保持する。
  URL は絶対に削除・改変しない。
- kind='value'(育成)は宣伝・購入誘導・URL を入れない。ハッシュタグは本文に足さない(後段で付与)。
- 文字数はチャンネルに適した長さに収める(X は日本語で概ね120字以内)。
- 元が十分良ければ無理に変えず changed=false とし、revised_body には元本文をそのまま返す。
- 各 draft の id を必ず1件ずつ、過不足なく含める。

出力は JSON のみ。スキーマ: {"revisions":[{"id":string,"changed":boolean,"revised_body":string,"reason":string}]}`;

const SEEDS: Seed[] = [
  {
    role: 'content_optimizer',
    body: BODY,
    placeholders: ['channel_label'],
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
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
