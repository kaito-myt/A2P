/**
 * scripts/measure-real-run.ts — Phase 1 実走計測ハーネス (SP-09 T-09-08)
 *
 * 本番 (Railway) で 1 冊を実 LLM で完走させた **後**、その書籍の Job / TokenUsage を
 * DB から集計し、コスト・リードタイム・各フェーズ時間・PDF 生成時間を算出して
 * `docs/operations/phase1-real-run.md` に転記できる Markdown を標準出力に吐く。
 *
 * 使い方 (本番 DATABASE_URL を指定して実行):
 *   DATABASE_URL=<prod> pnpm tsx scripts/measure-real-run.ts <book_id>
 *
 * 注意:
 *  - 本スクリプトは **計測のみ**。実 LLM 呼び出し (= 課金) は行わない。
 *  - 実走そのもの (テーマ投入 → 完成) は UI / パイプラインで人間が起動する。
 *  - 集計は token_usage (CLAUDE.md Hard Rule 5 で全 LLM/画像呼び出しが記録される) を正典とする。
 */
import { prisma } from '@a2p/db';
import { getBookCostBreakdown } from '@a2p/db/cost-aggregation';

function ms(a: Date | null, b: Date | null): number | null {
  if (!a || !b) return null;
  return b.getTime() - a.getTime();
}

function fmtDur(msVal: number | null): string {
  if (msVal == null) return '—';
  const s = Math.round(msVal / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}分${rem}秒` : `${rem}秒`;
}

function yen(n: number): string {
  return `¥${n.toFixed(2)}`;
}

async function main(): Promise<void> {
  const bookId = process.argv[2];
  if (!bookId) {
    // eslint-disable-next-line no-console
    console.error('usage: pnpm tsx scripts/measure-real-run.ts <book_id>');
    process.exit(1);
  }

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
      title: true,
      status: true,
      created_at: true,
      done_at: true,
      cost_jpy_total: true,
    },
  });
  if (!book) {
    // eslint-disable-next-line no-console
    console.error(`book ${bookId} not found`);
    process.exit(1);
  }

  // --- コスト分解 (token_usage 正典) ---------------------------------------
  const breakdown = await getBookCostBreakdown(prisma, bookId);

  // --- ジョブ時系列 (フェーズ別リードタイム) -------------------------------
  const jobs = await prisma.job.findMany({
    where: { book_id: bookId },
    select: {
      kind: true,
      status: true,
      created_at: true,
      started_at: true,
      finished_at: true,
    },
    orderBy: { created_at: 'asc' },
  });

  // --- 役割別コスト --------------------------------------------------------
  const byRole = await prisma.tokenUsage.groupBy({
    by: ['role', 'provider', 'model'],
    where: { book_id: bookId },
    _sum: { cost_jpy: true, input_tokens: true, output_tokens: true, image_count: true },
  });

  const leadTimeMs = ms(book.created_at, book.done_at);
  const totalCost = breakdown.total_cost_jpy;

  // --- 出力 (Markdown) -----------------------------------------------------
  const out: string[] = [];
  out.push(`### 計測結果 — ${book.title} (\`${book.id}\`)`);
  out.push('');
  out.push(`- ステータス: ${book.status}`);
  out.push(`- 投入 (created_at): ${book.created_at.toISOString()}`);
  out.push(`- 完成 (done_at): ${book.done_at ? book.done_at.toISOString() : '— (未完)'}`);
  out.push(`- **総リードタイム**: ${fmtDur(leadTimeMs)}`);
  out.push(`- **総コスト (token_usage 合算)**: ${yen(totalCost)}`);
  out.push('');

  out.push('#### フェーズ別ジョブ時間');
  out.push('');
  out.push('| kind | status | 待機(enq→start) | 実行(start→finish) |');
  out.push('|---|---|---|---|');
  for (const j of jobs) {
    out.push(
      `| ${j.kind} | ${j.status} | ${fmtDur(ms(j.created_at, j.started_at))} | ${fmtDur(ms(j.started_at, j.finished_at))} |`,
    );
  }
  out.push('');

  out.push('#### 役割別コスト');
  out.push('');
  out.push('| role | provider | model | cost | in tok | out tok | images |');
  out.push('|---|---|---|---|---|---|---|');
  for (const r of byRole) {
    out.push(
      `| ${r.role} | ${r.provider} | ${r.model} | ${yen(r._sum.cost_jpy ?? 0)} | ${r._sum.input_tokens ?? 0} | ${r._sum.output_tokens ?? 0} | ${r._sum.image_count ?? 0} |`,
    );
  }
  out.push('');

  // --- PDF 生成時間 (export 系ジョブ) --------------------------------------
  const exportJobs = jobs.filter((j) => /export|pdf|render/i.test(j.kind));
  out.push('#### PDF / 成果物生成時間 (OQ-01 判断材料)');
  out.push('');
  if (exportJobs.length === 0) {
    out.push('> export/pdf 系ジョブが見つかりませんでした。kind 命名を確認してください。');
  } else {
    for (const j of exportJobs) {
      out.push(`- ${j.kind}: ${fmtDur(ms(j.started_at, j.finished_at))}`);
    }
  }
  out.push('');

  // --- 100 冊/月 試算 ------------------------------------------------------
  out.push('#### 月次 100 冊試算');
  out.push('');
  out.push(`- 1 冊あたり実コスト: ${yen(totalCost)}`);
  out.push(`- × 100 冊 = ${yen(totalCost * 100)}`);
  out.push(
    `- 月額予算 ¥50,000 以内か: **${totalCost * 100 <= 50000 ? 'YES ✅' : 'NO ⚠️ 要プロンプト/モデル最適化'}**`,
  );
  out.push('');

  // eslint-disable-next-line no-console
  console.log(out.join('\n'));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
