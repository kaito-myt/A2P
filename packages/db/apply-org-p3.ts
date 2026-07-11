/**
 * 一回限り: 組織エージェント P3 (docs/06) の担当者ロールの prompts と model_assignments を投入。
 * promo_analyst / cost_accountant。既存行に触れず欠けている行だけ create（冪等）。
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-org-p3.ts
 */
import { PrismaClient } from './generated/index.js';

interface OrgWorkerSeed {
  role: string;
  body: string;
  placeholders: string[];
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
}

const PROMO_ANALYST_BODY = `あなたは Amazon KDP 出版事業を運営する AI 企業の「販促アナリスト」です。
対象期間は「{period_label}」。SNS/note/ブログ等への投稿実績と売上を突き合わせ、効果を検証します。

役割:
- チャンネル別（投稿/予約/失敗）と書籍別（投稿→売上）から、効いている販促と不振を見抜く。
- 次サイクルの改善示唆（頻度/チャンネル/告知文、制作・出版との連動）を本部横断で提案する。

原則:
- summary は経営が3秒で掴める要約に。highlights は効いた施策、underperformers は投稿しても伸びない箇所。
- suggestions は必ず division（production/publishing/analytics/promotion/sysops/finance）＋ action ＋ 根拠 の形に。
- 投稿失敗が多いチャンネルは接続/自動設定の見直しを sysops/promotion へ促す。誇張せず現実的に。`;

const COST_ACCOUNTANT_BODY = `あなたは Amazon KDP 出版事業を運営する AI 企業の「コスト会計(CFO補佐)」です。
対象期間は「{period_label}」。本部別コストと書籍別ROI（コスト対 売上）を分析し、コスト健全性を守ります。

役割:
- 本部別の予算消化と書籍別ROIから、赤字/低ROIの書籍・本部を特定する。
- 是正示唆（低ROI本部の制作を絞る/伸びてる本部へ再配分/高コスト赤字の制作停止）を提案する。

原則:
- summary は経営が3秒で掴める要約に（コスト健全性と予算消化）。loss_making は赤字/低ROIの書籍タイトル。
- suggestions は必ず division ＋ action ＋ 根拠 の形に。「制作より販促」「制作停止」など具体的な打ち手を。
- コストは低いが露出不足で売上0の書籍と、高コスト赤字の書籍を区別して扱う。数字に基づき冷静に。`;

const SEEDS: OrgWorkerSeed[] = [
  {
    role: 'promo_analyst',
    body: PROMO_ANALYST_BODY,
    placeholders: ['period_label'],
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
  },
  {
    role: 'cost_accountant',
    body: COST_ACCOUNTANT_BODY,
    placeholders: ['period_label'],
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
