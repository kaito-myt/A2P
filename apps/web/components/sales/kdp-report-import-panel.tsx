'use client';

/**
 * KdpReportImportPanel (F-056) — KDP ダッシュボードの .xlsx をそのまま取り込む。
 * 「電子書籍のロイヤリティ」シートを解析し (ASIN, 年月) ごとに JPY ロイヤリティを
 * SalesRecord に upsert する。ASIN で書籍を照合。
 */
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';

import { importKdpReport } from '@/app/actions/kdp-report';
import { messages } from '@/lib/messages';
import type { KdpImportResult } from '@/lib/kdp-report-core';

const m = messages.salesManual.kdp;

export function KdpReportImportPanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<KdpImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createExternal, setCreateExternal] = useState(true);

  function onPick(file: File | null) {
    setResult(null);
    setError(null);
    if (!file) {
      setFileName(null);
      return;
    }
    setFileName(file.name);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('create_external', createExternal ? 'true' : 'false');
    start(async () => {
      const res = await importKdpReport(fd);
      if (!res.ok) {
        setError(res.error?.message ?? m.error);
        return;
      }
      setResult(res.data);
      router.refresh();
    });
  }

  return (
    <section
      className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed"
      data-testid="kdp-report-import-panel"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-card-title font-medium text-charcoal">{m.title}</h2>
        <p className="text-caption text-muted">{m.subtitle}</p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".xlsx"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={pending}
        className="inline-flex w-fit items-center gap-2 rounded-card bg-charcoal px-3 py-1.5 text-button-sm text-cream-light shadow-l2-inset hover:opacity-80 disabled:opacity-50"
      >
        <Upload aria-hidden className="h-4 w-4" />
        {pending ? m.importing : m.pick}
      </button>
      {fileName && <span className="text-caption text-muted">{fileName}</span>}

      <label className="flex items-center gap-2 text-caption text-charcoal-82">
        <input
          type="checkbox"
          checked={createExternal}
          onChange={(e) => setCreateExternal(e.target.checked)}
          disabled={pending}
        />
        {m.createExternalLabel}
      </label>

      {error && <p className="text-button-sm text-destructive" role="alert">{error}</p>}

      {result && (
        <div className="flex flex-col gap-1 rounded-card border border-border-warm bg-cream p-space-snug text-caption text-charcoal-82">
          <span className="font-medium text-success">{m.done(result.inserted + result.updated)}</span>
          <span>{m.detail(result.inserted, result.updated, result.parsedRows)}</span>
          {result.createdExternal > 0 && <span className="text-accent">{m.createdExternal(result.createdExternal)}</span>}
          {result.skippedNonJpy > 0 && <span>{m.skippedNonJpy(result.skippedNonJpy)}</span>}
          {result.notFound.length > 0 && (
            <div className="mt-1 flex flex-col gap-0.5">
              <span className="text-warning">{m.notFoundTitle(result.notFound.length)}</span>
              {result.notFound.slice(0, 5).map((r) => (
                <span key={`${r.asin}-${r.year_month}`} className="text-muted">
                  ・{r.asin}（{r.title || '—'}） {r.year_month}：¥{r.royalty_jpy.toLocaleString('ja-JP')}
                </span>
              ))}
              <span className="text-muted">{m.notFoundHint}</span>
            </div>
          )}
        </div>
      )}
      <p className="text-caption text-muted">{m.help}</p>
    </section>
  );
}
