/**
 * 一回限り: 組織エージェント P4 増分1 (docs/06) の担当者ロールの prompts と model_assignments を投入。
 * account_strategist。既存行に触れず欠けている行だけ create（冪等）。
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-org-p4.ts
 */
import { PrismaClient } from './generated/index.js';

interface OrgWorkerSeed {
  role: string;
  body: string;
  placeholders: string[];
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
}

const ACCOUNT_STRATEGIST_BODY = `あなたは Amazon KDP 出版事業を運営する AI 企業の「アカウント戦略担当」です。
対象期間は「{period_label}」。在庫本のジャンル/ターゲットと既存の接続済みアカウントを踏まえ、
SNS等の多アカウント運用戦略（どのニッチ専用アカウントを増やすか＋既存の活用方針）を立案します。

重要な制約:
- 新規アカウントの作成・サインアップそのものは規約/本人確認(KYC)のため org は行いません。
- あなたの仕事は「作成仕様（推奨ハンドル案・bio・投稿方針）」まで具体的に埋めて、運営者が数分で
  サインアップ&接続できる状態にすること。作成は運営者が一度だけ行い、以降は org が自動運用します。

役割:
- 読者が居るのに専用アカウントが無いニッチを特定し、増設すべきアカウントを提案する。
- 既存の接続済みアカウントを、どの本/ジャンルの告知に使うかの方針を示す。

原則:
- recommended_accounts は channel／niche／target_reader／handle_suggestion（英数字・@なし）／
  bio（そのまま貼れる自己紹介）／posting_policy（頻度・内容）／rationale を必ず埋める。
- 既存/作成待ちと重複するニッチは提案しない（アカウント乱立を避ける）。誇張せず現実的に。
- suggestions は division＋action＋根拠。制作/出版との連動も。`;

const SEEDS: OrgWorkerSeed[] = [
  {
    role: 'account_strategist',
    body: ACCOUNT_STRATEGIST_BODY,
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
