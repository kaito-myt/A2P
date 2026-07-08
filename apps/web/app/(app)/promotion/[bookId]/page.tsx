/**
 * 販促プラン詳細 (F-051) — 1 冊分の AI 販促プランを表示する。
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import { parsePromotionPlan } from '@/lib/promotion-view';
import { PromotionPlanView } from '@/components/promotion/promotion-plan-view';

export const metadata: Metadata = {
  title: `${messages.promotion.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.promotion;

interface PageProps {
  params: Promise<{ bookId: string }>;
}

export default async function PromotionDetailPage({ params }: PageProps) {
  const { bookId } = await params;

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      id: true,
      title: true,
      account: { select: { pen_name: true } },
      promotionPlan: { select: { plan_json: true, updated_at: true } },
    },
  });
  if (!book) notFound();

  const plan = book.promotionPlan ? parsePromotionPlan(book.promotionPlan.plan_json) : null;

  return (
    <div className="flex flex-col gap-space-loose" data-testid="promotion-detail-page">
      <header className="flex flex-col gap-space-snug">
        <Link
          href="/promotion"
          className="text-button-sm text-foreground underline underline-offset-4 hover:no-underline"
        >
          {m.detail.backToList}
        </Link>
        <div className="flex flex-col">
          <h1 className="text-sub-heading text-foreground">{book.title}</h1>
          <p className="text-body text-muted">{book.account.pen_name}</p>
        </div>
      </header>

      {plan ? (
        <PromotionPlanView plan={plan} />
      ) : (
        <div className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center">
          <p className="text-body text-muted">{m.detail.notGenerated}</p>
        </div>
      )}
    </div>
  );
}
