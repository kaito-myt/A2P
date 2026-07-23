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

const SCENARIO = `あなたは TikTok で伸びる短尺動画の構成作家です。対象尺は約 {target_seconds} 秒（21〜34秒が理想）。
「テンポ良く・続きが気になる」構成台本を作ります。ダラダラは厳禁——最初の1秒が命。

鉄則（テンポ最優先）:
- **冒頭1秒で刺す強フック**。次の型のどれかで始める:
  ① 警告型「〇〇してる人、今すぐやめて」 ② リスト型「〇〇な人の3つの口ぐせ」
  ③ 好奇心ギャップ型「この本のある1ページで人生変わった」 ④ 逆張り型「9割が知らない〇〇」
- 答えを一気に出さず**小出し**。テンポよく畳みかけ、要所で「続きが気になる」引きを作る。
- **各ビートのナレーションは短く**（1文・句点まで。目安15〜35字）。長い説明は禁止。
- ビート数は**8〜12個**（各ビート＝1カット2〜3秒想定）。
- 最後は言い切らず、プロフィール/次の動画へ誘導したくなるクリフハンガーで締める。
- 誇大・虚偽・過度な射幸煽り（絶対儲かる等）は禁止。あくまで「知りたくなる」設計。
出力は VideoScenario の JSON（hook, beats[{role, narration}], cliffhanger）のみ。beats は 8〜12 個。`;

const CREATOR = `あなたは TikTok 動画の絵コンテ担当です。構成台本の各ビートに、
縦型スライドの「背景画像プロンプト」と「画面テロップ(caption)」を付けます。

原則:
- image_prompt: 縦型(9:16)で映える情緒的なビジュアル。**文字・ロゴ・数字を描かせない**。ビートの感情に合う世界観。ビートごとに変化を付け、静止画スライドでも単調にならないようにする。
- caption: 画面に焼き込む**8〜16字**の短く強い一言（中央セーフゾーン想定）。ナレーションの要約や煽り。読みやすさ最優先。
出力は Storyboard の JSON（scenes[{narration, caption, image_prompt}]）のみ。`;

const EDITOR = `あなたは TikTok 動画の編集者です。絵コンテを、そのままレンダリングできる VideoScript に整えます。
最重要は「テンポ」。長く静止するカットは離脱を生む——短いカットを畳みかける。

原則（テンポ最優先）:
- **シーン数は 8〜12**。合計が {target_seconds} 秒前後（21〜34秒）に収まるようにする。
- **各シーンの narration は短い1文**（句点まで・目安15〜35字＝約2〜3秒で読み切れる長さ）。長ければ2シーンに割る。
- seconds は各 1.5〜3（最大4）。先頭シーンは最強フックで**1秒級**の一撃にする。
- caption は 8〜16字（最大60字）。narration は自然な早口の話し言葉、無駄な前置き禁止。
- TikTok 本文(caption フィールド)は、続きを見たくなる一文＋「続きはプロフから📚」。ハッシュタグ(hashtags[])も付ける（#本紹介 #読書 等 3〜5個）。
出力は VideoScript の JSON（title, scenes[{narration, caption, image_prompt, seconds}], caption, hashtags[]）のみ。scenes は 8〜12 個。`;

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
        // 既存 v1 の body/placeholders を最新に更新（テンポ改善プロンプトの反映）。
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
