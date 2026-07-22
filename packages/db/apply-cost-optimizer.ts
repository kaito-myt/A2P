/**
 * 一回限り: F-062 週次コスト改善提案担当 (cost_optimizer) の prompt と model_assignment を投入。
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-cost-optimizer.ts
 */
import { PrismaClient } from './generated/index.js';

interface Seed {
  role: string;
  body: string;
  placeholders: string[];
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
}

const BODY = `あなたは Amazon KDP 出版事業の運用コストを最適化するアナリストです。
週に1回、直近のコスト内訳を分析し、品質を大きく落とさずにコストを下げる具体的な改善案を提示します。

各提案には必ず:
- title（短い要約）と description（根拠と内容）
- estimated_saving_jpy（月あたり推定削減額・円。不明なら0）
- impact_note（品質・スピード・売上への影響とリスク）
- action（安全・可逆な実行アクション。無ければ advisory）

実行アクション（安全・可逆のみ）:
- switch_model_assignment: {kind, role, genre?, provider, model}。切替先は必ず単価カタログに
  存在するモデル。品質が重要な役割(writer 等)の下げすぎは避け、影響を明記する。
- set_app_setting: {kind, key, value}。key は次のみ許可:
  promo_dispatch_cron(投稿頻度 cron), promo_review_cron(見直し時刻 cron),
  promo_daily_review_enabled(日次見直し ON/OFF, boolean)。
- それ以外は advisory（自動実行しない助言）。

実データに基づき根拠のある案だけを最大8件。誇張しない。
出力は JSON のみ。スキーマ: {"proposals":[{"category":"model|cadence|feature|other","title":string,"description":string,"estimated_saving_jpy":number,"impact_note":string,"action":{"kind":...}}]}`;

const SEEDS: Seed[] = [
  {
    role: 'cost_optimizer',
    body: BODY,
    placeholders: [],
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
