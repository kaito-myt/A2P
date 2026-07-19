/**
 * 販促チャンネル自動運用 (F-052) — SNS / note / ブログの投稿キューと自動運用設定。
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import { ChannelBoard } from '@/components/promotion/channel-board';
import {
  isPromotionChannel,
  parseStrategyProfile,
  type ChannelPostRow,
  type ChannelSettingView,
  type ChannelStrategyView,
  type PromotionChannel,
} from '@/lib/promotion-channels-view';

export const dynamic = 'force-dynamic';

const m = messages.promotionChannels;

interface PageProps {
  params: Promise<{ channel: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { channel } = await params;
  const name = isPromotionChannel(channel) ? m.channelNames[channel] : '';
  return { title: `${name} ${m.pageTitleSuffix} | ${messages.brand.appName}` };
}

function toIso(d: Date | null | undefined): string | null {
  return d instanceof Date ? d.toISOString() : null;
}

export default async function PromotionChannelPage({ params }: PageProps) {
  const { channel } = await params;
  if (!isPromotionChannel(channel)) notFound();
  const ch: PromotionChannel = channel;

  const [settingRow, postRows] = await Promise.all([
    prisma.promotionChannelSetting.findUnique({ where: { channel: ch } }),
    prisma.promotionPost.findMany({
      where: { channel: ch },
      orderBy: [{ scheduled_for: 'desc' }],
      take: 60,
      select: {
        id: true,
        title: true,
        body: true,
        status: true,
        scheduled_for: true,
        posted_at: true,
        external_url: true,
        error: true,
        book: { select: { id: true, title: true } },
      },
    }),
  ]);

  const webhookUrl =
    settingRow?.config_json && typeof settingRow.config_json === 'object'
      ? ((settingRow.config_json as Record<string, unknown>).webhook_url as string | null) ?? null
      : null;

  // F-058: IG/TikTok は Ayrshare 経由。API キーがあれば接続済み扱い。
  const ayrshareManaged = (ch === 'instagram' || ch === 'tiktok') && Boolean(process.env.AYRSHARE_API_KEY);

  const setting: ChannelSettingView = {
    channel: ch,
    autoEnabled: settingRow?.auto_enabled ?? false,
    handle: settingRow?.handle ?? null,
    webhookUrl,
    tokenMask: settingRow?.token_mask ?? null,
    connected: Boolean(settingRow?.token_enc) || Boolean(webhookUrl) || ayrshareManaged,
    ayrshareManaged,
  };

  const strategy: ChannelStrategyView = {
    displayName: settingRow?.display_name ?? null,
    updatedAt: toIso(settingRow?.strategy_updated_at ?? null),
    hasAvatar: Boolean(settingRow?.avatar_key),
    hasBanner: Boolean(settingRow?.banner_key),
    profile: parseStrategyProfile(settingRow?.strategy_json ?? null),
  };

  const posts: ChannelPostRow[] = postRows.map((p) => ({
    id: p.id,
    bookId: p.book.id,
    bookTitle: p.book.title,
    title: p.title,
    body: p.body,
    status: p.status,
    scheduledFor: toIso(p.scheduled_for),
    postedAt: toIso(p.posted_at),
    externalUrl: p.external_url,
    error: p.error,
  }));

  return (
    <div className="flex flex-col gap-space-loose" data-testid="promotion-channel-page">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <Link href="/promotion" className="no-underline hover:underline">
            {m.breadcrumbPromotion}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.channelNames[ch]}</span>
        </nav>
        <div className="flex flex-col">
          <h1 className="text-sub-heading text-foreground">
            {m.channelNames[ch]} {m.pageTitleSuffix}
          </h1>
          <p className="text-body text-muted">{m.subtitle}</p>
        </div>
      </header>

      <ChannelBoard channel={ch} setting={setting} strategy={strategy} posts={posts} />
    </div>
  );
}
