/**
 * S-019 モデル割当（役割 × ジャンル） (docs/04 §4 S-019 / wireframes prompt.md).
 *
 * 構成 (タスク T-02-11):
 *   1. パンくず + ページタイトル
 *   2. AssignmentMatrix (7 役 × 4 ジャンルスロット)
 *   3. AssignmentHistoryTable (全 ModelAssignment 履歴、active + archived)
 *
 * RSC で Prisma を直接呼び、Decimal / Date を string にシリアライズしてから
 * Client Component に渡す (Decimal は React serializer を通せないため)。
 *
 * 注意: 進行中ジョブには本 SA は影響しない (Book.model_assignment_snapshot で
 * 作成時点の割当が凍結される設計、F-022/F-023 受入条件)。トーストで明示する
 * 文言は messages.modelAssignments.successUpsert を参照。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { AssignmentHistoryTable } from '@/components/models/assignment-history-table';
import { AssignmentMatrix } from '@/components/models/assignment-matrix';
import { ModelCatalogSidePane } from '@/components/models/model-catalog-side-pane';
import { messages } from '@/lib/messages';
import {
  buildAssignmentMatrix,
  type AssignmentRowSerialized,
  type CatalogRowSerialized,
} from '@/lib/model-assignments-view';

export const metadata: Metadata = {
  title: `${messages.modelAssignments.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.modelAssignments;

const HISTORY_TAKE = 100;

export default async function ModelAssignmentsPage() {
  const [activeRows, allRows, catalogRows] = await Promise.all([
    prisma.modelAssignment.findMany({
      where: { status: 'active' },
      orderBy: [{ role: 'asc' }, { genre: 'asc' }],
    }),
    prisma.modelAssignment.findMany({
      orderBy: [{ activated_at: 'desc' }],
      take: HISTORY_TAKE,
    }),
    prisma.modelCatalog.findMany({
      where: { is_current: true },
      orderBy: [{ provider: 'asc' }, { model: 'asc' }],
    }),
  ]);

  const activeSerialized: AssignmentRowSerialized[] = activeRows.map(serializeAssignment);
  const allSerialized: AssignmentRowSerialized[] = allRows.map(serializeAssignment);
  const catalogSerialized: CatalogRowSerialized[] = catalogRows.map((c) => ({
    id: c.id,
    provider: c.provider,
    model: c.model,
    input_price_per_mtok_usd: c.input_price_per_mtok_usd.toString(),
    output_price_per_mtok_usd: c.output_price_per_mtok_usd.toString(),
    fx_rate_usd_jpy: c.fx_rate_usd_jpy.toString(),
  }));

  const cells = buildAssignmentMatrix(activeSerialized, catalogSerialized);

  return (
    <div className="flex flex-col gap-space-loose">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbModels}</span>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbAssignments}</span>
        </nav>
        <div className="flex flex-col">
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
      </header>

      <div className="grid gap-space-loose md:grid-cols-[minmax(0,1fr)_22rem]">
        <AssignmentMatrix cells={cells} catalog={catalogSerialized} />
        <ModelCatalogSidePane catalog={catalogSerialized} />
      </div>

      <AssignmentHistoryTable rows={allSerialized} />
    </div>
  );
}

function serializeAssignment(a: {
  id: string;
  role: string;
  genre: string | null;
  provider: string;
  model: string;
  status: string;
  activated_at: Date;
  archived_at: Date | null;
  created_by: string;
}): AssignmentRowSerialized {
  return {
    id: a.id,
    role: a.role,
    genre: a.genre,
    provider: a.provider,
    model: a.model,
    status: a.status,
    activated_at: a.activated_at.toISOString(),
    archived_at: a.archived_at ? a.archived_at.toISOString() : null,
    created_by: a.created_by,
  };
}
