/**
 * モデル比較（バエオフ）(F-053) — 同一役割×入力を複数モデルで走らせ品質/コスト/速度を比較。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import { BakeoffManager } from '@/components/bakeoff/bakeoff-manager';
import type { BakeoffRunRow, CandidateModel } from '@/lib/bakeoff-view';

export const metadata: Metadata = {
  title: `${messages.bakeoff.pageTitle} | ${messages.brand.appName}`,
};
export const dynamic = 'force-dynamic';

const m = messages.bakeoff;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'object' && 'toNumber' in (v as object) ? (v as { toNumber(): number }).toNumber() : Number(v);
  return Number.isFinite(n) ? n : null;
}

export default async function BakeoffPage() {
  const [catalog, runsRaw] = await Promise.all([
    prisma.modelCatalog.findMany({
      where: { is_current: true },
      select: { provider: true, model: true },
      orderBy: [{ provider: 'asc' }, { model: 'asc' }],
    }),
    prisma.bakeoffRun.findMany({
      orderBy: { created_at: 'desc' },
      take: 30,
      include: { results: { orderBy: [{ rank: 'asc' }] } },
    }),
  ]);

  // テキスト比較に使えない画像モデルは候補から除外。
  const candidates: CandidateModel[] = catalog
    .filter((c) => !/image/i.test(c.model))
    .map((c) => ({ provider: c.provider, model: c.model }));

  const runs: BakeoffRunRow[] = runsRaw.map((r) => ({
    id: r.id,
    role: r.role,
    genre: r.genre,
    inputLabel: r.input_label,
    status: r.status,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : null,
    results: r.results.map((x) => ({
      id: x.id,
      provider: x.provider,
      model: x.model,
      outputText: x.output_text,
      qualityScore: x.quality_score,
      rank: x.rank,
      rationale: x.rationale,
      costJpy: num(x.cost_jpy),
      latencyMs: x.latency_ms,
      error: x.error,
    })),
  }));

  return (
    <div className="flex flex-col gap-space-loose" data-testid="bakeoff-page">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.pageTitle}</span>
        </nav>
        <div className="flex flex-col">
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
      </header>

      <BakeoffManager candidates={candidates} runs={runs} />
    </div>
  );
}
