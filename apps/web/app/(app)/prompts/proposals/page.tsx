/**
 * S-023 プロンプト改訂承認画面 (T-11-07).
 *
 * RSC page:
 *  - listProposals / getAutoApprovalStatus を Promise.all で並列取得
 *  - ?id= searchParams で getProposalDetail を条件取得
 *  - 提案 0 件 → EmptyState
 *  - 左カラム: AutoApprovalStatusBar + ProposalsTable
 *  - 右カラム: ProposalDetail (選択時) または「提案を選択してください」ヒント
 *
 * 仕様根拠: docs/04 S-023 / docs/05 §4.3.12 / SP-11 T-11-07
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import {
  listProposals,
  getProposalDetail,
  getAutoApprovalStatus,
} from '@/lib/prompt-proposals-view';
import { AutoApprovalStatusBar } from '@/components/prompt-proposals/auto-approval-status-bar';
import { ProposalsTable } from '@/components/prompt-proposals/proposals-table';
import { ProposalDetail } from '@/components/prompt-proposals/proposal-detail';

export const metadata: Metadata = {
  title: `${messages.promptProposals.page.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.promptProposals.page;
const mt = messages.promptProposals.table;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function sp(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

export default async function ProposalsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const selectedId = sp(params, 'id');

  const [proposals, autoApprovalStatus] = await Promise.all([
    listProposals(prisma),
    getAutoApprovalStatus(prisma),
  ]);

  const detail = selectedId ? await getProposalDetail(selectedId, prisma) : null;

  return (
    <div className="flex flex-col gap-space-loose" data-testid="proposals-page">
      {/* ページヘッダー */}
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbModels}</span>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbApproval}</span>
        </nav>
        <div>
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
      </header>

      {/* 自動承認ステータスバー */}
      <AutoApprovalStatusBar status={autoApprovalStatus} />

      {proposals.length === 0 ? (
        /* 提案 0 件: EmptyState */
        <div
          data-testid="proposals-empty-state"
          className="flex flex-col items-center gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
        >
          <p className="text-body font-medium text-charcoal">{mt.empty}</p>
          <p className="text-body text-muted">{mt.emptyHint}</p>
          <Link
            href="/prompts"
            className="mt-2 inline-flex cursor-pointer items-center rounded-card bg-charcoal px-4 py-2 text-button-sm text-white hover:bg-charcoal/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="proposals-empty-cta"
          >
            {mt.emptyCta}
          </Link>
        </div>
      ) : (
        /* 提案あり: 左右 2 カラムレイアウト */
        <div className="grid grid-cols-1 gap-space-loose lg:grid-cols-5">
          {/* 左カラム: 提案一覧 */}
          <div className="flex flex-col gap-space-snug lg:col-span-2">
            <h2 className="text-card-title font-medium text-foreground">
              {mt.sectionTitle}
            </h2>
            <ProposalsTable proposals={proposals} />
          </div>

          {/* 右カラム: 提案詳細 */}
          <div className="lg:col-span-3">
            {detail ? (
              <ProposalDetail proposal={detail} />
            ) : (
              <div
                data-testid="proposal-detail-empty"
                className="flex h-full min-h-48 items-center justify-center rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
              >
                <p className="text-body text-muted">
                  {messages.promptProposals.detail.notSelected}
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
