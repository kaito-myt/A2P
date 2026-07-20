'use client';

/**
 * ChannelBoard (F-052) — 1 チャンネルの自動運用ボード。
 *  - 上部: チャンネル切替タブ (SNS / note / ブログ)
 *  - 自動運用トグル
 *  - 接続設定フォーム (handle / webhook / token)
 *  - 投稿キュー (予定/投稿済/失敗 + 手動投稿・取消)
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import {
  cancelPromotionPost,
  generateChannelStrategy,
  generateChannelContent,
  publishPostNow,
  setChannelAuto,
  setChannelConnection,
  testChannelConnection,
} from '@/app/actions/promotion-channels';
import { messages } from '@/lib/messages';
import { cn } from '@/lib/cn';
import {
  PROMOTION_CHANNELS,
  type ChannelPostRow,
  type ChannelSettingView,
  type ChannelStrategyView,
  type PromotionChannel,
} from '@/lib/promotion-channels-view';

const m = messages.promotionChannels;

function statusLabel(status: string): string {
  return (m.status as Record<string, string>)[status] ?? status;
}

function statusClass(status: string): string {
  switch (status) {
    case 'posted':
      return 'bg-success-bg text-success';
    case 'failed':
      return 'bg-destructive-bg text-destructive';
    case 'posting':
      return 'bg-accent-bg text-accent';
    case 'canceled':
    case 'skipped':
      return 'bg-charcoal-04 text-muted';
    default:
      return 'bg-charcoal-04 text-charcoal-82';
  }
}

export function ChannelBoard({
  channel,
  setting,
  strategy,
  posts,
}: {
  channel: PromotionChannel;
  setting: ChannelSettingView;
  strategy: ChannelStrategyView;
  posts: ChannelPostRow[];
}) {
  return (
    <div className="flex flex-col gap-space-loose">
      <ChannelTabs active={channel} />
      <StrategyCard channel={channel} strategy={strategy} />
      <AutomationCard setting={setting} />
      {channel === 'blog' ? <OwnedBlogNote /> : <ConnectionCard setting={setting} />}
      <QueueTable posts={posts} />
    </div>
  );
}

function OwnedBlogNote() {
  return (
    <Card title={m.connSection.title}>
      <p className="text-body text-charcoal-82">{m.ownedBlogNote}</p>
      <a
        href="/blog"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal no-underline hover:bg-charcoal-04"
      >
        /blog を開く
      </a>
    </Card>
  );
}

function ChannelTabs({ active }: { active: PromotionChannel }) {
  return (
    <div
      role="tablist"
      aria-label={m.tabsAria}
      className="flex gap-1 border-b border-border-warm"
    >
      {PROMOTION_CHANNELS.map((ch) => {
        const selected = ch === active;
        return (
          <Link
            key={ch}
            role="tab"
            aria-selected={selected}
            href={`/promotion/channel/${ch}`}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-button-sm no-underline transition-colors',
              selected
                ? 'border-accent font-medium text-accent'
                : 'border-transparent text-charcoal-82 hover:text-charcoal',
            )}
          >
            {m.channelNames[ch]}
          </Link>
        );
      })}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed">
      <h2 className="text-card-title font-medium text-charcoal">{title}</h2>
      {children}
    </section>
  );
}

function StrategyCard({
  channel,
  strategy,
}: {
  channel: PromotionChannel;
  strategy: ChannelStrategyView;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [instruction, setInstruction] = useState('');
  const [queued, setQueued] = useState(false);
  const [contentQueued, setContentQueued] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const s = m.strategy;
  const p = strategy.profile;

  function generate() {
    setQueued(false);
    setContentQueued(false);
    setErr(null);
    start(async () => {
      const res = await generateChannelStrategy({ channel, instruction: instruction.trim() });
      if (res.ok) {
        setQueued(true);
        setInstruction('');
        router.refresh();
      } else {
        setErr(res.error?.message ?? m.actionMsg.error);
      }
    });
  }

  function generateContent() {
    setQueued(false);
    setContentQueued(false);
    setErr(null);
    start(async () => {
      const res = await generateChannelContent({ channel });
      if (res.ok) {
        setContentQueued(true);
        router.refresh();
      } else {
        setErr(res.error?.message ?? m.actionMsg.error);
      }
    });
  }

  return (
    <Card title={s.title}>
      <p className="text-body text-muted">{s.description}</p>

      {p ? (
        <div className="flex flex-col gap-space-relaxed" data-testid={`strategy-profile-${channel}`}>
          {/* 画像プレビュー: カバー + アイコン */}
          <div className="relative">
            {strategy.hasBanner ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/promotion/${channel}/banner`}
                alt={s.bannerAlt}
                className="h-32 w-full rounded-card border border-border-warm object-cover"
              />
            ) : (
              <div className="flex h-32 w-full items-center justify-center rounded-card border border-dashed border-border-warm bg-charcoal-04 text-caption text-muted">
                {s.noImage}
              </div>
            )}
            {strategy.hasAvatar && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/promotion/${channel}/avatar`}
                alt={s.avatarAlt}
                className="absolute -bottom-5 left-4 h-16 w-16 rounded-full border-2 border-cream-light object-cover shadow-l2-inset"
              />
            )}
          </div>

          <div className="mt-3 flex flex-col gap-1">
            <div className="text-card-title font-medium text-charcoal">{p.display_name}</div>
            <div className="text-caption text-muted">@{p.handle_suggestion}</div>
          </div>

          <Field label={s.concept}>{p.concept}</Field>
          <Field label={s.bio}>
            <span className="whitespace-pre-wrap">{p.bio}</span>
          </Field>

          <div className="flex flex-col gap-space-snug">
            <span className="text-button-sm font-medium text-charcoal-82">{s.pillars}</span>
            <div className="grid gap-space-snug sm:grid-cols-2">
              {p.content_pillars.map((pillar, i) => (
                <div key={i} className="rounded-default border border-border-warm bg-cream p-space-snug">
                  <div className="text-button-sm font-medium text-charcoal">{pillar.name}</div>
                  <div className="mt-0.5 text-caption text-muted">{pillar.description}</div>
                  <div className="mt-1 whitespace-pre-wrap rounded bg-charcoal-04 px-2 py-1 text-caption text-charcoal-82">
                    {pillar.example_post}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-space-snug sm:grid-cols-2">
            <Field label={s.tone}>{p.tone_of_voice}</Field>
            <Field label={s.cadence}>
              {p.posting_cadence.frequency}
              {p.posting_cadence.best_times.length > 0 && (
                <span className="text-muted"> ・ {p.posting_cadence.best_times.join(' / ')}</span>
              )}
            </Field>
          </div>

          {(p.hashtag_strategy.core.length > 0 || p.hashtag_strategy.rotating.length > 0) && (
            <div className="flex flex-col gap-1">
              <span className="text-button-sm font-medium text-charcoal-82">{s.hashtags}</span>
              <div className="flex flex-wrap gap-1">
                {p.hashtag_strategy.core.map((t, i) => (
                  <span key={`c${i}`} className="rounded-pill bg-accent-bg px-2 py-0.5 text-caption text-accent">
                    {t}
                  </span>
                ))}
                {p.hashtag_strategy.rotating.map((t, i) => (
                  <span key={`r${i}`} className="rounded-pill bg-charcoal-04 px-2 py-0.5 text-caption text-charcoal-82">
                    {t}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <span className="text-button-sm font-medium text-charcoal-82">{s.growth}</span>
            <ul className="ml-4 list-disc text-caption text-charcoal-82">
              {p.growth_tactics.map((g, i) => (
                <li key={i}>{g}</li>
              ))}
            </ul>
          </div>

          {strategy.updatedAt && (
            <p className="text-caption text-muted">
              {s.updatedAt}: {new Date(strategy.updatedAt).toLocaleString('ja-JP')}
            </p>
          )}
        </div>
      ) : (
        <p className="text-body text-charcoal-82" data-testid={`strategy-empty-${channel}`}>
          {s.empty}
        </p>
      )}

      {/* 生成/再生成コントロール */}
      <div className="mt-2 flex flex-col gap-space-snug rounded-default border border-border-warm/70 bg-cream p-space-snug">
        <label className="flex flex-col gap-1">
          <span className="text-caption text-charcoal-82">{s.instructionLabel}</span>
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={s.instructionPlaceholder}
            rows={2}
            className="w-full rounded-default border border-border-warm bg-cream-light px-3 py-2 text-button-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <div className="flex flex-wrap items-center gap-space-snug">
          <button
            type="button"
            onClick={generate}
            disabled={pending}
            data-testid={`strategy-generate-${channel}`}
            className="inline-flex items-center rounded-card bg-charcoal px-3 py-1.5 text-button-sm text-cream-light shadow-l2-inset hover:opacity-80 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {pending ? s.generating : p ? s.regenerate : s.generate}
          </button>
          {p && (
            <button
              type="button"
              onClick={generateContent}
              disabled={pending}
              data-testid={`content-generate-${channel}`}
              className="inline-flex items-center rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {s.generateContent}
            </button>
          )}
          {queued && <span className="text-caption text-success">{s.queued}</span>}
          {contentQueued && <span className="text-caption text-success">{s.contentQueued}</span>}
          {err && <span className="text-caption text-destructive">{err}</span>}
        </div>
        <p className="text-caption text-muted">{s.applyHint}</p>
        <p className="text-caption text-muted">{s.contentHint}</p>
      </div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-caption font-medium text-charcoal-82">{label}</span>
      <div className="text-body text-charcoal">{children}</div>
    </div>
  );
}

function AutomationCard({ setting }: { setting: ChannelSettingView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [enabled, setEnabled] = useState(setting.autoEnabled);

  function toggle() {
    const next = !enabled;
    start(async () => {
      const res = await setChannelAuto({ channel: setting.channel, auto_enabled: next });
      if (res.ok) {
        setEnabled(next);
        router.refresh();
      }
    });
  }

  return (
    <Card title={m.autoSection.title}>
      <p className="text-body text-muted">{m.autoSection.description}</p>
      <div className="flex flex-wrap items-center gap-space-snug">
        <span
          className={cn(
            'rounded-pill px-2.5 py-1 text-caption font-medium',
            enabled ? 'bg-success-bg text-success' : 'bg-charcoal-04 text-charcoal-82',
          )}
        >
          {enabled ? m.autoSection.enabled : m.autoSection.disabled}
        </span>
        <button
          type="button"
          onClick={toggle}
          disabled={pending}
          className={cn(
            'inline-flex items-center rounded-card px-3 py-1.5 text-button-sm shadow-l2-inset disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
            enabled
              ? 'border border-border-warm bg-cream text-charcoal hover:bg-charcoal-04'
              : 'bg-charcoal text-cream-light hover:opacity-80',
          )}
        >
          {enabled ? m.autoSection.disable : m.autoSection.enable}
        </button>
        {!setting.connected && (
          <span className="text-caption text-warning">{m.connSection.notConnected}</span>
        )}
      </div>
      <p className="text-caption text-muted">{m.autoSection.note}</p>
    </Card>
  );
}

function ConnectionCard({ setting }: { setting: ChannelSettingView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const isX = setting.channel === 'x';
  const isAyrshare = setting.channel === 'instagram' || setting.channel === 'tiktok';
  const [handle, setHandle] = useState(setting.handle ?? '');
  const [webhook, setWebhook] = useState(setting.webhookUrl ?? '');
  const [token, setToken] = useState('');
  // X 用 OAuth 1.0a の4値。
  const [xApiKey, setXApiKey] = useState('');
  const [xApiSecret, setXApiSecret] = useState('');
  const [xAccessToken, setXAccessToken] = useState('');
  const [xAccessTokenSecret, setXAccessTokenSecret] = useState('');
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const xAllFilled =
    xApiKey.trim() !== '' &&
    xApiSecret.trim() !== '' &&
    xAccessToken.trim() !== '' &&
    xAccessTokenSecret.trim() !== '';

  function save() {
    setSaved(false);
    setTestResult(null);
    start(async () => {
      const res = await setChannelConnection({
        channel: setting.channel,
        handle,
        webhook_url: webhook,
        ...(isX && xAllFilled
          ? {
              x_api_key: xApiKey,
              x_api_secret: xApiSecret,
              x_access_token: xAccessToken,
              x_access_token_secret: xAccessTokenSecret,
            }
          : {}),
        ...(!isX && token.trim().length > 0 ? { token } : {}),
      });
      if (res.ok) {
        setSaved(true);
        setToken('');
        setXApiKey('');
        setXApiSecret('');
        setXAccessToken('');
        setXAccessTokenSecret('');
        router.refresh();
      }
    });
  }

  function runTest() {
    setSaved(false);
    setTestResult(null);
    setTesting(true);
    start(async () => {
      const res = await testChannelConnection({ channel: setting.channel });
      if (res.ok) {
        setTestResult({ ok: res.data.ok, message: res.data.message });
      } else {
        setTestResult({ ok: false, message: res.error?.message ?? m.actionMsg.error });
      }
      setTesting(false);
    });
  }

  const inputCls =
    'w-full rounded-default border border-border-warm bg-cream-light px-3 py-2 text-button-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <Card title={m.connSection.title}>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'rounded-pill px-2.5 py-1 text-caption font-medium',
            setting.connected ? 'bg-success-bg text-success' : 'bg-charcoal-04 text-charcoal-82',
          )}
        >
          {setting.connected ? m.connSection.connected : m.connSection.notConnected}
        </span>
      </div>
      {isAyrshare && (
        <div className="flex flex-col gap-1 rounded-default border border-accent/30 bg-accent-bg/40 p-space-snug">
          <span className="text-button-sm font-medium text-charcoal">{m.connSection.ayrshareTitle}</span>
          <p className="text-caption text-charcoal-82">{m.connSection.ayrshareNote}</p>
        </div>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-button-sm text-charcoal-82">{m.connSection.handleLabel}</span>
        <input
          className={inputCls}
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder={m.connSection.handlePlaceholder}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-button-sm text-charcoal-82">{m.connSection.webhookLabel}</span>
        <input
          className={inputCls}
          value={webhook}
          onChange={(e) => setWebhook(e.target.value)}
          placeholder="https://…"
        />
        <span className="text-caption text-muted">{m.connSection.webhookHelp}</span>
      </label>
      {isX ? (
        <div className="flex flex-col gap-space-snug rounded-default border border-border-warm/70 bg-cream p-space-snug">
          <span className="text-button-sm font-medium text-charcoal-82">{m.connSection.xCredsTitle}</span>
          <p className="text-caption text-muted">{m.connSection.xCredsHelp}</p>
          {(
            [
              ['apiKey', m.connSection.xApiKey, xApiKey, setXApiKey],
              ['apiSecret', m.connSection.xApiSecret, xApiSecret, setXApiSecret],
              ['accessToken', m.connSection.xAccessToken, xAccessToken, setXAccessToken],
              ['accessTokenSecret', m.connSection.xAccessTokenSecret, xAccessTokenSecret, setXAccessTokenSecret],
            ] as const
          ).map(([key, label, value, setter]) => (
            <label key={key} className="flex flex-col gap-1">
              <span className="text-caption text-charcoal-82">{label}</span>
              <input
                type="password"
                className={inputCls}
                value={value}
                onChange={(e) => setter(e.target.value)}
                placeholder={setting.tokenMask ? m.connSection.tokenPlaceholderSet : m.connSection.tokenPlaceholder}
                autoComplete="off"
                data-testid={`x-cred-${key}`}
              />
            </label>
          ))}
          {setting.tokenMask && (
            <span className="text-caption text-muted">
              {m.connSection.xAccessToken}: {setting.tokenMask}
            </span>
          )}
        </div>
      ) : (
        <label className="flex flex-col gap-1">
          <span className="text-button-sm text-charcoal-82">{m.connSection.tokenLabel}</span>
          <input
            type="password"
            className={inputCls}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={setting.tokenMask ? m.connSection.tokenPlaceholderSet : m.connSection.tokenPlaceholder}
            autoComplete="off"
          />
          {setting.tokenMask && <span className="text-caption text-muted">{setting.tokenMask}</span>}
        </label>
      )}
      <div className="flex flex-wrap items-center gap-space-snug">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="inline-flex items-center rounded-card bg-charcoal px-3 py-1.5 text-button-sm text-cream-light shadow-l2-inset hover:opacity-80 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {m.connSection.save}
        </button>
        <button
          type="button"
          onClick={runTest}
          disabled={pending}
          data-testid={`channel-test-${setting.channel}`}
          className="inline-flex items-center rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {testing ? m.connSection.testing : m.connSection.test}
        </button>
        {saved && <span className="text-caption text-success">{m.connSection.saved}</span>}
      </div>
      {testResult && (
        <p
          role="status"
          data-testid={`channel-test-result-${setting.channel}`}
          className={cn(
            'rounded-default border px-3 py-2 text-caption',
            testResult.ok
              ? 'border-success/40 bg-success-bg text-success'
              : 'border-destructive/40 bg-destructive-bg text-destructive',
          )}
        >
          {testResult.message}
        </p>
      )}
      <p className="text-caption text-muted">{m.connSection.testHint}</p>
    </Card>
  );
}

function QueueTable({ posts }: { posts: ChannelPostRow[] }) {
  return (
    <Card title={m.queue.title}>
      {posts.length === 0 ? (
        <p className="text-body text-muted">{m.queue.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-button-sm">
            <thead>
              <tr className="border-b border-border-warm text-left text-caption text-muted">
                <th className="py-2 pr-3 font-medium">{m.queue.book}</th>
                <th className="py-2 pr-3 font-medium">{m.queue.scheduledFor}</th>
                <th className="py-2 pr-3 font-medium">{m.queue.status}</th>
                <th className="py-2 pr-3 font-medium">{m.queue.body}</th>
                <th className="py-2 font-medium">{m.queue.actions}</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <PostRow key={p.id} post={p} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PostRow({ post }: { post: ChannelPostRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  const canAct = ['scheduled', 'failed', 'draft'].includes(post.status);

  function doPublish() {
    setMsg(null);
    start(async () => {
      const res = await publishPostNow({ post_id: post.id });
      setMsg(res.ok ? m.actionMsg.published : res.error?.message ?? m.actionMsg.publishFailed);
      if (res.ok) router.refresh();
    });
  }
  function doCancel() {
    setMsg(null);
    start(async () => {
      const res = await cancelPromotionPost({ post_id: post.id });
      setMsg(res.ok ? m.actionMsg.canceled : res.error?.message ?? m.actionMsg.error);
      if (res.ok) router.refresh();
    });
  }

  return (
    <tr className="border-b border-border-warm/70 align-top">
      <td className="py-2 pr-3">
        <span
          className={cn(
            'mb-0.5 inline-block rounded-pill px-1.5 py-0.5 text-caption',
            post.kind === 'value' ? 'bg-accent-bg text-accent' : 'bg-charcoal-04 text-charcoal-82',
          )}
        >
          {post.kind === 'value' ? m.queue.kindValue : m.queue.kindPromo}
        </span>
        <span className="line-clamp-2 text-charcoal">{post.bookTitle}</span>
      </td>
      <td className="py-2 pr-3 whitespace-nowrap text-charcoal-82">
        {post.scheduledFor ? new Date(post.scheduledFor).toLocaleString('ja-JP') : '—'}
      </td>
      <td className="py-2 pr-3">
        <span className={cn('rounded-pill px-2 py-0.5 text-caption', statusClass(post.status))}>
          {statusLabel(post.status)}
        </span>
        {post.error && <div className="mt-1 max-w-[220px] text-caption text-destructive">{post.error}</div>}
      </td>
      <td className="py-2 pr-3">
        {post.title && <div className="font-medium text-charcoal">{post.title}</div>}
        <div className="max-w-[320px] whitespace-pre-wrap break-words text-charcoal-82 line-clamp-3">
          {post.body}
        </div>
      </td>
      <td className="py-2">
        <div className="flex flex-col items-start gap-1">
          {post.externalUrl && (
            <a
              href={post.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2"
            >
              {m.queue.view}
            </a>
          )}
          {canAct && (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={doPublish}
                disabled={pending}
                className="rounded-card border border-border-warm bg-cream px-2.5 py-1 text-caption text-charcoal hover:bg-charcoal-04 disabled:opacity-50"
              >
                {pending ? m.queue.publishing : m.queue.publishNow}
              </button>
              <button
                type="button"
                onClick={doCancel}
                disabled={pending}
                className="rounded-card border border-border-warm bg-cream px-2.5 py-1 text-caption text-destructive hover:bg-destructive-bg disabled:opacity-50"
              >
                {m.queue.cancel}
              </button>
            </div>
          )}
          {msg && <span className="text-caption text-muted">{msg}</span>}
        </div>
      </td>
    </tr>
  );
}
