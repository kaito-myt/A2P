/**
 * 一回限り: OpenAI(GPT) の主要モデルを model_catalog に is_current=true で登録する。
 * OpenAI の pricing ページは SPA でスクレイプ不能なため、キュレート単価を直接投入する
 * (以後は catalog.fetch のフォールバックが維持)。
 *   DATABASE_URL=<target> pnpm --filter @a2p/db exec tsx apply-openai-catalog.ts
 */
import { PrismaClient, Prisma } from './generated/index.js';

// apps/worker の OPENAI_CURATED_PRICING と同値 (import 循環を避けるため直書き)。
const CURATED = [
  { model: 'gpt-5', input: 1.25, output: 10.0, image: null as number | null },
  { model: 'gpt-5-mini', input: 0.25, output: 2.0, image: null },
  { model: 'gpt-4.1', input: 2.0, output: 8.0, image: null },
  { model: 'gpt-4o', input: 2.5, output: 10.0, image: null },
  { model: 'gpt-4o-mini', input: 0.15, output: 0.6, image: null },
  { model: 'gpt-image-1', input: 0, output: 0, image: 0.04 },
];

async function main() {
  const prisma = new PrismaClient();
  try {
    const settings = await prisma.appSettings.findUnique({ where: { id: 'singleton' } });
    const fx = settings?.latest_fx_rate ?? new Prisma.Decimal(150);
    const fetchedAt = new Date();
    const names = CURATED.map((c) => c.model);

    await prisma.modelCatalog.updateMany({
      where: { provider: 'openai', model: { in: names }, is_current: true },
      data: { is_current: false },
    });

    let n = 0;
    for (const c of CURATED) {
      await prisma.modelCatalog.create({
        data: {
          provider: 'openai',
          model: c.model,
          input_price_per_mtok_usd: new Prisma.Decimal(c.input),
          output_price_per_mtok_usd: new Prisma.Decimal(c.output),
          image_price_per_image_usd: c.image !== null ? new Prisma.Decimal(c.image) : null,
          fx_rate_usd_jpy: fx,
          fetched_at: fetchedAt,
          source: 'openai_curated_fallback_v1',
          raw_json: { curated: true, seeded_at: fetchedAt.toISOString() },
          is_current: true,
        },
      });
      n++;
      console.log(`inserted openai/${c.model}`);
    }
    console.log(`done: ${n} OpenAI models registered (is_current)`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
