/**
 * S-005 長期出版プラン RSC ページ (T-08-02, F-002).
 *
 * アカウントの最新 PublishingPlan を取得してクライアントシェルに渡す。
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { prisma } from '@a2p/db';

import { serializePlansPage } from '@/lib/plans-view';
import { messages } from '@/lib/messages';
import { PlansPageShell } from '@/components/plans/plans-page-shell';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const account = await prisma.account.findUnique({
    where: { id },
    select: { pen_name: true, display_name: true },
  });
  const name = account?.display_name ?? account?.pen_name ?? id;
  return {
    title: `${messages.plans.pageTitle(name)} | ${messages.brand.appName}`,
  };
}

export default async function PlansPage({ params }: PageProps) {
  const { id } = await params;

  const account = await prisma.account.findUnique({
    where: { id },
    select: { id: true, pen_name: true, display_name: true },
  });
  if (!account) notFound();

  // 最新 PublishingPlan (period_from 降順で 1 件)
  const latestPlan = await prisma.publishingPlan.findFirst({
    where: { account_id: id },
    orderBy: { period_from: 'desc' },
    select: {
      id: true,
      account_id: true,
      period_from: true,
      period_to: true,
      plan_json: true,
      created_at: true,
    },
  });

  const data = serializePlansPage(account, latestPlan);

  return <PlansPageShell data={data} />;
}
