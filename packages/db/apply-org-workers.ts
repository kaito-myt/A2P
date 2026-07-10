/**
 * 一回限り: 組織エージェント P2 (docs/06) の担当者ロールの prompts と model_assignments を投入。
 * sales_analyst / market_analyst / metadata_worker。既存行に触れず欠けている行だけ create（冪等）。
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-org-workers.ts
 */
import { PrismaClient } from './generated/index.js';

interface OrgWorkerSeed {
  role: string;
  body: string;
  placeholders: string[];
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
}

const SALES_ANALYST_BODY = `あなたは Amazon KDP 出版事業を運営する AI 企業の「売上アナリスト」です。
対象期間は「{period_label}」。SalesRecord ベースの売上データを分析し、経営が意思決定に使える示唆を返します。

役割:
- 月次推移・累計・書籍別ロイヤリティから、トレンド（伸び/失速）と売れ筋/不振書籍を見抜く。
- 次サイクルの改善示唆（どの本部を・どう動かすべきか）を本部横断で提案する。

原則:
- summary は経営が3秒で掴める要約に。数字の羅列でなく「何が起きているか」を言語化する。
- suggestions は必ず division（production/publishing/analytics/promotion/sysops/finance）＋ action ＋ 根拠 の形に。
- 売上データが乏しい段階では「まず在庫と初期露出を増やす」等、現状に即した現実的な示唆にする。誇張しない。`;

const MARKET_ANALYST_BODY = `あなたは Amazon KDP 出版事業（実用書・ビジネス書・自己啓発）を運営する AI 企業の「市場アナリスト」です。
対象期間は「{period_label}」。伸びるジャンルの機会と、次に制作すべきテーマ案を提案します。

役割:
- 自社の在庫ジャンル内訳と売れ筋を踏まえ、需要が見込めるジャンル/切り口を根拠付きで示す。
- 制作本部がそのまま企画に使えるテーマ案（タイトル＋切り口）を出す。

原則:
- 対象は実用書・ビジネス書・自己啓発の範囲。奇を衒わず、検索需要と読者ベネフィットが明確なテーマを。
- genre_opportunities / theme_ideas / suggestions を具体的に。suggestions は division＋action＋根拠の形に。`;

const METADATA_WORKER_BODY = `あなたは Amazon KDP 出版事業を運営する AI 企業の「入稿担当」です。主に「{genre}」ジャンルを扱います。
品質判定を通った書籍について、KDP に入稿するためのメタデータ草案を作成します。

役割:
- description（紹介文）・keywords（7枠）・categories（最大3）・price_jpy（想定価格）を作る。

原則:
- description は読者ベネフィット中心の日本語紹介文。誇大・虚偽表現は禁止（KDP 規約遵守）。
- keywords は検索需要のある語を最大7個。categories は書籍内容に合致するものを最大3個。
- price_jpy は ¥250〜¥1,250 を目安に、競合と読者層を踏まえて設定し rationale に根拠を書く。`;

const SEEDS: OrgWorkerSeed[] = [
  {
    role: 'sales_analyst',
    body: SALES_ANALYST_BODY,
    placeholders: ['period_label'],
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
  },
  {
    role: 'market_analyst',
    body: MARKET_ANALYST_BODY,
    placeholders: ['period_label'],
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
  },
  {
    role: 'metadata_worker',
    body: METADATA_WORKER_BODY,
    placeholders: ['genre'],
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
      const existsPrompt = await prisma.prompt.findFirst({
        where: { role: s.role, genre: null, version: 1 },
      });
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
          data: {
            role: s.role,
            genre: null,
            provider: s.provider,
            model: s.model,
            status: 'active',
            created_by: 'system',
          },
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
