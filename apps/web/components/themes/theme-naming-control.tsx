'use client';

/**
 * ThemeNamingControl — テーマに著者名 / レーベル名 (マスタ) をプルダウンで割り当てる。
 *
 * ここで選んだ著者名は書籍の表紙 (合成タイポグラフィ) に、レーベル名は出版レーベルに
 * 使われる。マスタは /masters で管理する。
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { updateThemeNaming } from '@/app/actions/themes';
import { messages } from '@/lib/messages';

const m = messages.themeNaming;

export interface NamingOption {
  id: string;
  name: string;
}

export function ThemeNamingControl({
  themeId,
  authorOptions,
  labelOptions,
  currentAuthorId,
  currentLabelId,
}: {
  themeId: string;
  authorOptions: NamingOption[];
  labelOptions: NamingOption[];
  currentAuthorId: string | null;
  currentLabelId: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [authorId, setAuthorId] = useState(currentAuthorId ?? '');
  const [labelId, setLabelId] = useState(currentLabelId ?? '');
  const [info, setInfo] = useState<string | null>(null);

  function persist(nextAuthor: string, nextLabel: string) {
    setInfo(null);
    start(async () => {
      const res = await updateThemeNaming({
        theme_id: themeId,
        author_name_id: nextAuthor || null,
        label_name_id: nextLabel || null,
      });
      setInfo(res.ok ? m.saved : res.error?.message ?? m.error);
      if (res.ok) router.refresh();
    });
  }

  const noMasters = authorOptions.length === 0 && labelOptions.length === 0;

  return (
    <section
      className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed"
      data-testid="theme-naming-control"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <h2 className="text-card-title font-medium text-charcoal">{m.heading}</h2>
          <p className="text-button-sm text-muted">{m.subtitle}</p>
        </div>
        <Link
          href="/masters"
          className="text-button-sm text-accent underline underline-offset-4 hover:no-underline"
        >
          {m.manageLink}
        </Link>
      </div>

      {noMasters ? (
        <p className="text-button-sm text-warning">{m.noMasters}</p>
      ) : (
        <div className="grid grid-cols-1 gap-space-snug sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-button-sm text-charcoal-82">{m.authorLabel}</span>
            <select
              className="rounded-card border border-border-warm bg-cream px-3 py-1.5 text-body text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              value={authorId}
              disabled={pending}
              onChange={(e) => {
                setAuthorId(e.target.value);
                persist(e.target.value, labelId);
              }}
              data-testid="theme-author-select"
            >
              <option value="">{m.none}</option>
              {authorOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-button-sm text-charcoal-82">{m.labelLabel}</span>
            <select
              className="rounded-card border border-border-warm bg-cream px-3 py-1.5 text-body text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              value={labelId}
              disabled={pending}
              onChange={(e) => {
                setLabelId(e.target.value);
                persist(authorId, e.target.value);
              }}
              data-testid="theme-label-select"
            >
              <option value="">{m.none}</option>
              {labelOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {info && <span className="text-button-sm text-success">{info}</span>}
    </section>
  );
}
