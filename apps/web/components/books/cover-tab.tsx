'use client';

/**
 * S-010 書籍詳細「カバー」タブ。
 *
 * 生成済みカバー画像 (covers) をグリッド表示する。画像は R2 (非公開) に保存され、
 * `/api/covers/{id}/image` が署名 URL へ 302 リダイレクトして配信する。
 * next/image の最適化は Cookie 非送出で middleware に弾かれるため素の <img> を使う。
 *
 * F-041b: 手動作成したカバー画像をアップロードして採用に差し替えるコントロールを持つ。
 */
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { messages } from '@/lib/messages';
import type { BookCoverSerialized } from '@/lib/books-view';

const m = messages.books;

export function CoverTab({ covers, bookId }: { covers: BookCoverSerialized[]; bookId: string }) {
  return (
    <div className="flex flex-col gap-space-relaxed" data-testid="cover-tab">
      <CoverUploadControl bookId={bookId} />

      {covers.length === 0 ? (
        <div
          className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
          data-testid="cover-tab-empty"
        >
          <p className="text-body text-muted">{m.cover.empty}</p>
        </div>
      ) : (
        <div className="flex flex-wrap gap-space-relaxed">
          {covers.map((cover, idx) => (
            <figure
              key={cover.id}
              className={`flex w-[200px] flex-col gap-2 rounded-card border p-space-snug ${
                cover.status === 'adopted'
                  ? 'border-charcoal bg-cream'
                  : 'border-border-warm bg-cream-light'
              }`}
              data-testid={`book-cover-${cover.id}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- R2 署名 URL への 302 を Cookie 付きで取得するため素の img */}
              <img
                src={cover.imageUrl}
                alt={m.cover.altLabel(idx + 1)}
                loading="lazy"
                className="h-[300px] w-full rounded-default border border-border-warm bg-cream object-contain"
              />
              <figcaption className="flex items-center justify-between text-caption text-muted">
                <span>{m.cover.candidateLabel(idx + 1)}</span>
                {cover.status === 'adopted' && (
                  <span className="font-medium text-charcoal">{m.cover.adopted}</span>
                )}
                {cover.costJpy !== null && <span>¥{Math.round(cover.costJpy)}</span>}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

function CoverUploadControl({ bookId }: { bookId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const u = m.cover.upload;

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    setMsg(null);
    const f = e.target.files?.[0] ?? null;
    setFileName(f?.name ?? null);
  }

  function upload() {
    const f = inputRef.current?.files?.[0];
    if (!f) {
      setMsg({ ok: false, text: u.noFile });
      return;
    }
    setMsg(null);
    start(async () => {
      try {
        const fd = new FormData();
        fd.append('file', f);
        const res = await fetch(`/api/books/${bookId}/cover/upload`, { method: 'POST', body: fd });
        const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (res.ok && data.ok) {
          setMsg({ ok: true, text: u.success });
          setFileName(null);
          if (inputRef.current) inputRef.current.value = '';
          router.refresh();
        } else {
          setMsg({ ok: false, text: u.errorFor(data.error ?? String(res.status)) });
        }
      } catch {
        setMsg({ ok: false, text: u.networkError });
      }
    });
  }

  return (
    <section className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed">
      <h3 className="text-card-title font-medium text-charcoal">{u.title}</h3>
      <p className="text-caption text-muted">{u.description}</p>
      <div className="flex flex-wrap items-center gap-space-snug">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={onPick}
          data-testid="cover-upload-input"
          className="text-button-sm text-charcoal-82 file:mr-2 file:rounded-card file:border file:border-border-warm file:bg-cream file:px-3 file:py-1.5 file:text-button-sm file:text-charcoal hover:file:bg-charcoal-04"
        />
        <button
          type="button"
          onClick={upload}
          disabled={pending || !fileName}
          data-testid="cover-upload-submit"
          className="inline-flex items-center rounded-card bg-charcoal px-3 py-1.5 text-button-sm text-cream-light shadow-l2-inset hover:opacity-80 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {pending ? u.uploading : u.submit}
        </button>
      </div>
      {msg && (
        <span className={`text-caption ${msg.ok ? 'text-success' : 'text-destructive'}`}>{msg.text}</span>
      )}
      <p className="text-caption text-muted">{u.hint}</p>
    </section>
  );
}
