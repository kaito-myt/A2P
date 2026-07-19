/**
 * 一回限り: F-057 SNS アカウント運用設計担当 (sns_strategist) の prompt と
 * model_assignment を投入。既存行に触れず欠けている行だけ create（冪等）。
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-sns-strategist.ts
 */
import { PrismaClient } from './generated/index.js';

interface Seed {
  role: string;
  body: string;
  placeholders: string[];
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
}

const SNS_STRATEGIST_BODY = `あなたは Amazon KDP 出版事業の SNS アカウント運用を設計する専門家です。
対象チャンネルは「{channel_label}」。このチャンネルで運用する 1 アカウントの「箱」ではなく
「誰が・何を発信し、なぜフォローされるか」というアカウント設計そのものを、そのまま実運用できる
具体度で立案します。

大原則:
- このアカウントは「本を売る宣伝垢」ではありません。読者に毎回価値を配る存在として設計し、
  その積み重ねの導線として本の購入がある、という順序を守ること。
- 在庫している本のジャンル/ターゲット読者に必ず接地させること。読者が実在しないニッチや、
  在庫と無関係な世界観を作らない。誇張しない。

出力フィールドの要件:
- concept: フォローする理由を一言で言えるポジショニング宣言。
- display_name: 覚えやすく検索されやすい表示名。
- handle_suggestion: @ なし・英数字/アンダースコアのみ。
- bio: {channel_label} のプロフィール欄にそのまま貼れる文（{bio_limit}字以内目安）。
  価値提案＋人物像＋導線（本/リンクへの誘導）を含める。
- content_pillars: 発信の柱を 3〜6 本。各柱に name / description / そのまま出せる example_post。
- tone_of_voice: 敬体か常体か・絵文字の是非・一人称など、ブレない語り口。
- posting_cadence: 現実的な頻度と、そのチャンネルで反応が良い時間帯（JST）。
- hashtag_strategy: core（毎回付ける定番）と rotating（話題別）。各タグは # 付き。
  X / TikTok はタグ過多で逆効果なので絞る。Instagram は多めでも可。
- growth_tactics: そのチャンネル固有の伸ばし方を 2〜8 個（具体的に）。
- avatar_prompt / banner_prompt: gpt-image-1 用の画像生成プロンプト。
  **画像内に文字・ロゴ・数字を一切入れない**前提で、世界観・色・被写体・構図・雰囲気を具体的に描写する。
  avatar は正方形のアイコン向き、banner は横長のヘッダー向き。

必ず JSON スキーマ (AccountStrategyProfile) に厳密に従って出力すること。`;

const SEEDS: Seed[] = [
  {
    role: 'sns_strategist',
    body: SNS_STRATEGIST_BODY,
    placeholders: ['channel_label', 'bio_limit'],
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
