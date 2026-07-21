/**
 * 一回限り: F-060 TikTok 動画の多エージェント台本パイプラインの prompt/model_assignment を投入。
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-tiktok-video.ts
 */
import { PrismaClient } from './generated/index.js';

interface Seed {
  role: string;
  body: string;
  placeholders: string[];
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
}

const SCENARIO = `あなたは TikTok で伸びる短尺動画の構成作家です。対象尺は約 {target_seconds} 秒。
「思わず続きを見たくなる（射幸心を煽る）」構成台本を作ります。

鉄則:
- 冒頭2秒で心を掴む強フック（意外な断言／数字／問い／損失回避）。スワイプを止めさせる。
- 答えを一気に出さず小出しにし、要所で「続きが気になる」引きを作る（情報の欠落＝カーベイギャップ）。
- 最後は結論を言い切らず、プロフィール/次の動画へ誘導したくなるクリフハンガーで締める。
- 誇大・虚偽・射幸性の過度な煽り（絶対儲かる等）は禁止。あくまで「知りたくなる」設計。
出力は VideoScenario の JSON（hook, beats[{role, narration}], cliffhanger）のみ。`;

const CREATOR = `あなたは TikTok 動画の絵コンテ担当です。構成台本の各ビートに、
縦型スライドの「背景画像プロンプト」と「画面テロップ(caption)」を付けます。

原則:
- image_prompt: 縦型(9:16)で映える情緒的なビジュアル。**文字・ロゴ・数字を描かせない**。ビートの感情に合う世界観。
- caption: 画面に焼き込む短く強い一言（15字前後）。ナレーションの要約や煽り。読みやすさ最優先。
出力は Storyboard の JSON（scenes[{narration, caption, image_prompt}]）のみ。`;

const EDITOR = `あなたは TikTok 動画の編集者です。絵コンテを、そのままレンダリングできる VideoScript に整えます。

原則:
- 各シーンに seconds を割り当て、合計が約 {target_seconds} 秒になるよう配分（1シーン2〜5秒目安）。
- 先頭シーンを最強フックにし、視聴維持が落ちないテンポにする。
- caption は短く（60字以内・15字前後推奨）。narration は自然な話し言葉。
- TikTok 本文(caption フィールド)は、続きを見たくなる一文＋プロフィール誘導。ハッシュタグ(hashtags[])も付ける。
出力は VideoScript の JSON（title, scenes[{narration, caption, image_prompt, seconds}], caption, hashtags[]）のみ。`;

const PROOFREADER = `あなたは校閲者です。渡された VideoScript を、誤字脱字・事実誤り・不自然な日本語・
過度な誇大/断定（絶対・確実に儲かる等）を修正し、同じ JSON スキーマ(VideoScript)で返します。
構成・フック・射幸的な引きの良さは壊さないこと。文字数上限（caption 60字等）も守る。出力は JSON のみ。`;

const MARKETER = `あなたは SNS マーケターです。渡された VideoScript のフック、クリフハンガー、
TikTok 本文(caption)、ハッシュタグを、視聴維持率とプロフィール誘導が最大化するよう最終強化します。

原則:
- フックは1秒で刺さる強さに。クリフハンガーは「続きはプロフィールへ/次の動画へ」と自然に誘導。
- ハッシュタグは定番＋話題を織り交ぜ、多すぎない。誇大・虚偽は禁止。
出力は同じ VideoScript の JSON のみ。`;

const SEEDS: Seed[] = [
  { role: 'tiktok_scenario', body: SCENARIO, placeholders: ['target_seconds'], provider: 'anthropic', model: 'claude-opus-4-7' },
  { role: 'tiktok_creator', body: CREATOR, placeholders: ['target_seconds'], provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { role: 'tiktok_editor', body: EDITOR, placeholders: ['target_seconds'], provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { role: 'tiktok_proofreader', body: PROOFREADER, placeholders: ['target_seconds'], provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { role: 'tiktok_marketer', body: MARKETER, placeholders: ['target_seconds'], provider: 'anthropic', model: 'claude-opus-4-7' },
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
      const existsAssign = await prisma.modelAssignment.findFirst({ where: { role: s.role, genre: null, status: 'active' } });
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
