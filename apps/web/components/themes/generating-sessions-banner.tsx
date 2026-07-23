'use client';

/**
 * 生成中テーマのバナー (S-006 上部)。
 *
 * `pipeline.theme.generate` の未完了 Job を「生成中チップ」として並べ、クリックで
 * そのリクエスト内容 (ジャンル / キーワード / 生成数 / アカウント / 開始時刻) を
 * ポップアップ表示する。生成には 1〜2 分かかるため、一定間隔で router.refresh() し、
 * 完了すると Job が消えてチップも消え、新テーマが一覧に現れる。
 *
 * セッション横断一覧に切り替えたため、旧「セッション切替ピル」の代わりに
 * 「今どの生成が走っているか」だけをここで見せる。
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

import { messages } from '@/lib/messages';
import { formatDateTime, type GeneratingSession } from '@/lib/themes-view';

const m = messages.themes.generating;

interface GeneratingSessionsBannerProps {
  sessions: readonly GeneratingSession[];
}

export function GeneratingSessionsBanner({ sessions }: GeneratingSessionsBannerProps) {
  const router = useRouter();
  const [secs, setSecs] = useState(0);
  const [openJobId, setOpenJobId] = useState<string | null>(null);

  // 生成中の間だけ経過秒カウント + ポーリング。sessions が空なら何もしない。
  useEffect(() => {
    if (sessions.length === 0) return;
    const tick = setInterval(() => setSecs((s) => s + 1), 1000);
    const poll = setInterval(() => router.refresh(), 7000);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [router, sessions.length]);

  if (sessions.length === 0) return null;

  const open = sessions.find((s) => s.jobId === openJobId) ?? null;

  return (
    <section
      data-testid="themes-generating-banner"
      className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light px-space-relaxed py-space-snug"
    >
      <div className="flex items-center gap-2">
        <span className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-charcoal border-t-transparent" />
        <span className="text-button-sm font-medium text-charcoal">{m.heading}</span>
        <span className="text-caption text-muted">{m.elapsed(secs)}</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {sessions.map((s) => (
          <button
            key={s.jobId}
            type="button"
            onClick={() => setOpenJobId(s.jobId)}
            data-testid={`themes-generating-chip-${s.jobId}`}
            className="inline-flex items-center gap-1.5 rounded-pill border border-border-warm bg-cream px-2.5 py-1 text-caption text-charcoal-82 hover:bg-cream-light"
          >
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
            {s.genreLabel ? m.chip(s.genreLabel) : m.chipUnknown}
          </button>
        ))}
      </div>

      <p className="text-caption text-muted">{m.note}</p>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/40 p-space-relaxed"
          role="dialog"
          aria-modal="true"
          data-testid="themes-generating-popup"
          onClick={() => setOpenJobId(null)}
        >
          <div
            className="w-full max-w-md rounded-card border border-border-warm bg-cream-light p-space-loose shadow-l2"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-space-snug text-card-title text-foreground">{m.popupTitle}</h3>
            <dl className="flex flex-col gap-space-snug">
              <Field label={m.fieldGenre} value={open.genreLabel ?? '—'} />
              <Field label={m.fieldKeyword} value={open.keywordOrBrief ?? '—'} />
              <Field
                label={m.fieldCount}
                value={open.count != null ? `${open.count} ${m.countUnit}` : '—'}
              />
              <Field label={m.fieldAccount} value={open.accountLabel ?? '—'} />
              <Field label={m.fieldStartedAt} value={formatDateTime(open.createdAt)} />
            </dl>
            <div className="mt-space-relaxed flex justify-end">
              <button
                type="button"
                onClick={() => setOpenJobId(null)}
                className="rounded-default border border-border-warm bg-cream px-4 py-1.5 text-button-sm text-charcoal hover:bg-cream-light"
              >
                {m.close}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-caption text-muted">{label}</dt>
      <dd className="whitespace-pre-wrap break-words text-button-sm text-charcoal">{value}</dd>
    </div>
  );
}
