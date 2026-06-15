/**
 * S-008 新規プロジェクト / 夜間バッチ計画 (T-03-09 / docs/04 §4 S-008).
 *
 * Query string: `?theme_ids=id1,id2,id3` を parse → ThemeCandidate を fetch。
 * 採用済み (status='accepted') のみ受け入れる前提だが、UI 表示時は status を
 * そのまま見せ、status 不整合は SA 側 (`createBatchPlan`) で reject する設計。
 *
 * 構成:
 *  1. ページヘッダ + パンくず
 *  2. SelectedThemesList (RSC) — 選択 theme 一覧
 *  3. BatchScheduleForm + 送信ボタン (Client = BatchesPageShell)
 *  4. ModelAssignmentPreview (RSC) — 役割別 active assignment
 *  5. CostForecastCard (RSC) — 予測コスト
 *
 * 空状態:
 *  - theme_ids が空、または全件 DB に存在しない → 空状態カードで S-006 に誘導
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { getMonthlyTotalCost } from '@a2p/db/cost-aggregation';

import { BatchesPageShell } from '@/components/batches/batches-page-shell';
import { CostForecastCard } from '@/components/batches/cost-forecast-card';
import {
  ModelAssignmentPreview,
  type ModelAssignmentPreviewRow,
} from '@/components/batches/model-assignment-preview';
import {
  SelectedThemesList,
  type SelectedThemeRow,
} from '@/components/batches/selected-themes-list';
import {
  forecastBookCostJpy,
  projectExceedsRedThreshold,
  SNAPSHOT_ROLES,
} from '@/lib/batches-core';
import { messages } from '@/lib/messages';

export const metadata: Metadata = {
  title: `${messages.batches.newPageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.batches;

interface BatchesNewPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function parseThemeIds(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const str = Array.isArray(raw) ? raw.join(',') : raw;
  return str
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default async function BatchesNewPage({ searchParams }: BatchesNewPageProps) {
  const params = await searchParams;
  const themeIds = parseThemeIds(params.theme_ids);

  // 1. ThemeCandidate + Account の pen_name を fetch (空配列なら skip)
  const themes = themeIds.length
    ? await prisma.themeCandidate.findMany({
        where: { id: { in: themeIds } },
        include: { account: { select: { pen_name: true } } },
        orderBy: { created_at: 'desc' },
      })
    : [];

  // 2. ModelAssignment / ModelCatalog (予測コスト + プレビュー両方で使う)
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const [assignmentRows, catalogRows, appSettings, monthlyResult] = await Promise.all([
    prisma.modelAssignment.findMany({ where: { status: 'active' } }),
    prisma.modelCatalog.findMany({ where: { is_current: true } }),
    prisma.appSettings.findUnique({
      where: { id: 'singleton' },
      select: { monthly_cost_red_jpy: true, force_continue: true },
    }),
    getMonthlyTotalCost(prisma, year, month),
  ]);

  // 3. 表示用 SelectedThemeRow を構築
  const selectedRows: SelectedThemeRow[] = themes.map((t) => ({
    id: t.id,
    title: t.title,
    genre: t.genre,
    account_id: t.account_id,
    account_pen_name: t.account?.pen_name ?? null,
    target_reader: t.target_reader,
    status: t.status,
  }));

  // 4. ModelAssignmentPreview 用に 7 role を埋める (役割欠落は provider/model=null)
  const assignmentByRole = new Map<string, { provider: string; model: string }>();
  for (const a of assignmentRows) {
    // role × genre は SP-04 で扱う。SP-03 では「同 role の active を 1 件」採用する。
    if (!assignmentByRole.has(a.role)) {
      assignmentByRole.set(a.role, { provider: a.provider, model: a.model });
    }
  }
  const previewRows: ModelAssignmentPreviewRow[] = SNAPSHOT_ROLES.map((role) => {
    const a = assignmentByRole.get(role);
    return {
      role,
      provider: a?.provider ?? null,
      model: a?.model ?? null,
    };
  });

  // 5. 予測コスト
  const forecast = forecastBookCostJpy({
    themeCount: selectedRows.length,
    assignments: assignmentRows.map((a) => ({
      role: a.role,
      provider: a.provider,
      model: a.model,
    })),
    catalog: catalogRows.map((c) => ({
      provider: c.provider,
      model: c.model,
      inputPricePerMtokUsd: Number(c.input_price_per_mtok_usd),
      outputPricePerMtokUsd: Number(c.output_price_per_mtok_usd),
      imagePricePerImageUsd:
        c.image_price_per_image_usd === null
          ? null
          : Number(c.image_price_per_image_usd),
      fxRateUsdJpy: Number(c.fx_rate_usd_jpy),
    })),
  });

  // 6. canKick: 1 件以上 theme + 全 role の assignment + catalog が揃っていること
  const canKick =
    selectedRows.length > 0 &&
    catalogRows.length > 0 &&
    forecast.missingRoles.length === 0;

  // 7. 月次予算超過予測 (T-07-10)
  const totalDays = new Date(Date.UTC(year, month, 0)).getDate();
  const wouldExceedMonthly =
    appSettings !== null
      ? projectExceedsRedThreshold({
          actualCostJpy: monthlyResult.total_cost_jpy,
          batchCostJpy: forecast.totalJpy,
          elapsedDays: now.getUTCDate(),
          totalDays,
          redThresholdJpy: appSettings.monthly_cost_red_jpy,
        })
      : false;

  return (
    <div className="flex flex-col gap-space-loose">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <Link href="/themes" className="no-underline hover:underline">
            {m.breadcrumbPipeline}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <Link href="/batches" className="no-underline hover:underline">
            {m.breadcrumbBatches}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbNew}</span>
        </nav>
        <div className="flex flex-wrap items-start justify-between gap-space-snug">
          <div className="flex flex-col">
            <h1 className="text-sub-heading text-foreground">{m.newPageTitle}</h1>
            <p className="text-body text-muted">{m.newPageSubtitle}</p>
          </div>
          <Link
            href="/themes"
            className="text-button-sm text-foreground underline hover:no-underline"
            data-testid="batches-back-to-themes"
          >
            {m.actions.backToThemes}
          </Link>
        </div>
      </header>

      <div className="grid gap-space-loose md:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-space-loose">
          <SelectedThemesList rows={selectedRows} />
          <BatchesPageShell
            themeIds={selectedRows.map((r) => r.id)}
            themeCount={selectedRows.length}
            canKick={canKick}
            wouldExceedMonthly={wouldExceedMonthly}
          />
          <ModelAssignmentPreview rows={previewRows} />
        </div>
        <div className="flex flex-col gap-space-loose">
          <CostForecastCard
            themeCount={forecast.themeCount}
            perBookJpy={forecast.perBookJpy}
            totalJpy={forecast.totalJpy}
            missingRoles={forecast.missingRoles}
            catalogAvailable={catalogRows.length > 0}
            wouldExceedMonthly={wouldExceedMonthly}
          />
        </div>
      </div>
    </div>
  );
}
