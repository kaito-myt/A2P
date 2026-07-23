/**
 * 一回限り: F-064 研究駆動の販促プレイブック担当 (promo_strategist) の prompt と
 * model_assignment を投入。web_search を使うため provider=anthropic(Opus)。
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-promo-strategist.ts
 */
import { PrismaClient } from './generated/index.js';

interface Seed {
  role: string;
  body: string;
  placeholders: string[];
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
}

const BODY = `あなたは Amazon KDP 出版事業の SNS 販促を設計する、データに強いマーケティング戦略家です。
対象プラットフォームは「{channel_label}」、ジャンルは「{genre}」。

役割:
- web_search で「今この分野/プラットフォームで実際に伸びている本紹介・読書・販促アカウントの投稿」を
  リサーチし、再現可能な"勝ちパターン"を抽出して、投稿生成にそのまま注入できるプレイブックを作る。
- 一般論やテンプレ的助言ではなく、具体で実践的に。数字・型・実例で語る。

必ず調べて反映すること:
- 伸びている投稿のフックの型(冒頭で止める書き出し)、見出し/キャプションの型、構成。
- 反応(保存/シェア/フォロー)を生む CTA の書き方(プラットフォームの制約を踏まえる)。
- 効果的なハッシュタグ(規模別: ビッグ/ミッド/ニッチ)。
- 投稿に向く時間帯(JST)。
- {channel_label} が動画系なら視聴維持のテンポ/尺、画像系なら購買を促すデザイン要素。

禁止: 誇大・虚偽・過度な射幸煽り(絶対儲かる等)を推奨しない。誠実で価値ある発信を前提にする。

出力は JSON の PromoPlaybook のみ:
{"channel":string,"summary":string,
 "hook_formulas":[{"name":string,"template":string,"example":string}],
 "headline_styles":[string],"content_angles":[string],
 "hashtag_tiers":{"big":[string],"mid":[string],"niche":[string]},
 "cta_patterns":[string],"posting_times":[string],"creative_notes":[string],"do_this":[string]}
do_this は投稿生成へそのまま渡す短く強い実践指針(3〜6行)。`;

const SEEDS: Seed[] = [
  {
    role: 'promo_strategist',
    body: BODY,
    placeholders: ['channel_label', 'genre'],
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
        if (existsPrompt.body !== s.body) {
          await prisma.prompt.update({
            where: { id: existsPrompt.id },
            data: { body: s.body, placeholders_json: s.placeholders },
          });
          cp += 1;
          console.log(`prompt updated ${s.role}`);
        } else {
          console.log(`prompt up-to-date ${s.role}`);
        }
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
