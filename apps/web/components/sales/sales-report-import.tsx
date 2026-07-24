'use client';

/**
 * KDP 売上レポート取込 UI (docs/09 §3.1, T-KS-05)。
 *
 * 「レポート取込」ボタン → モーダル: アカウント + 対象年月 + ファイル(xlsx/csv) を指定して
 * プレビュー → 突合結果テーブルを確認 → 取込。取込は sales_records に upsert される。
 */
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import {
  previewSalesReport,
  commitSalesReport,
  type SalesImportPreview,
} from '@/app/actions/sales-import';

interface AccountOption {
  id: string;
  pen_name: string;
}

/** 既定の対象年月 = 先月 (KDP は月次確定のため)。JST 概算で十分。 */
function defaultYearMonth(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-11 → 先月 = m (今月-1) を 1-12 に
  const target = m === 0 ? { y: y - 1, mo: 12 } : { y, mo: m };
  return `${target.y}-${String(target.mo).padStart(2, '0')}`;
}

export function SalesReportImport({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [yearMonth, setYearMonth] = useState(defaultYearMonth());
  const [preview, setPreview] = useState<SalesImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setPreview(null);
    setError(null);
    setInfo(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  function handlePreview() {
    setError(null);
    setInfo(null);
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('レポートファイル (xlsx/csv) を選択してください');
      return;
    }
    const fd = new FormData();
    fd.set('file', file);
    fd.set('year_month', yearMonth);
    startTransition(async () => {
      const res = await previewSalesReport(fd);
      if (!res.ok) {
        setError(res.error.message);
        setPreview(null);
        return;
      }
      setPreview(res.data);
    });
  }

  function handleCommit() {
    if (!preview || !accountId) return;
    setError(null);
    const rows = preview.rows
      .filter((r) => r.bookId)
      .map((r) => ({
        asin: r.asin,
        royalty_jpy: r.royalty_jpy,
        units_sold: r.units_sold,
        kenp_read: r.kenp_read,
      }));
    if (rows.length === 0) {
      setError('突合できた書籍がありません (ASIN が A2P の書籍と一致しません)');
      return;
    }
    startTransition(async () => {
      const res = await commitSalesReport({
        account_id: accountId,
        year_month: preview.yearMonth,
        report_kind: preview.reportKind,
        rows,
      });
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      const kindLabel = preview.reportKind === 'estimate' ? '見込み' : '確定';
      const extras: string[] = [];
      if (res.data.skippedUnknownAsin) extras.push(`未突合 ${res.data.skippedUnknownAsin} 件`);
      if (res.data.skippedConfirmed) extras.push(`確定値優先で見送り ${res.data.skippedConfirmed} 件`);
      setInfo(
        `${res.data.upserted} 冊分を${kindLabel}として取り込みました${extras.length ? `（${extras.join(' / ')}）` : ''}`,
      );
      setPreview(null);
      if (fileRef.current) fileRef.current.value = '';
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="sales-import-open"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04"
      >
        レポート取込
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-charcoal/40 p-space-relaxed"
          role="dialog"
          aria-modal="true"
          data-testid="sales-import-modal"
          onClick={() => {
            setOpen(false);
            reset();
          }}
        >
          <div
            className="my-8 w-full max-w-3xl rounded-card border border-border-warm bg-cream-light p-space-loose shadow-l2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-space-snug flex items-start justify-between">
              <div>
                <h3 className="text-card-title text-foreground">KDP 売上レポート取込</h3>
                <p className="mt-1 text-caption text-muted">
                  「レポート＞明細＞<b>月別ロイヤリティ</b>」= 確定値、「<b>ロイヤリティ推定</b>」= 当月見込み。
                  どちらの xlsx でも取り込めます。対象年月を選んでアップロードしてください（ASIN で書籍と突合）。
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
                className="text-button-sm text-muted hover:text-charcoal"
              >
                ✕
              </button>
            </div>

            <div className="flex flex-wrap items-end gap-space-snug">
              <label className="flex flex-col gap-1">
                <span className="text-caption text-muted">アカウント</span>
                <select
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  className="rounded-default border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal"
                  data-testid="sales-import-account"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.pen_name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-caption text-muted">対象年月</span>
                <input
                  type="month"
                  value={yearMonth}
                  onChange={(e) => setYearMonth(e.target.value)}
                  className="rounded-default border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal"
                  data-testid="sales-import-month"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-caption text-muted">レポートファイル</span>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="text-button-sm text-charcoal"
                  data-testid="sales-import-file"
                />
              </label>
              <button
                type="button"
                onClick={handlePreview}
                disabled={pending}
                className="rounded-default bg-charcoal px-4 py-1.5 text-button-sm text-cream-light hover:opacity-90 disabled:opacity-50"
                data-testid="sales-import-preview-btn"
              >
                {pending ? '解析中…' : 'プレビュー'}
              </button>
            </div>

            {error && (
              <p className="mt-space-snug text-button-sm text-destructive" data-testid="sales-import-error">
                {error}
              </p>
            )}
            {info && (
              <p className="mt-space-snug text-button-sm text-success" data-testid="sales-import-info">
                {info}
              </p>
            )}

            {preview && (
              <div className="mt-space-relaxed flex flex-col gap-space-snug" data-testid="sales-import-preview">
                <div className="flex flex-wrap items-center gap-x-space-relaxed gap-y-1 text-caption text-charcoal-82">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-caption font-medium ${
                      preview.reportKind === 'estimate'
                        ? 'bg-warning/15 text-warning'
                        : 'bg-success/15 text-success'
                    }`}
                    data-testid="sales-import-kind"
                  >
                    {preview.reportKind === 'estimate' ? '当月見込み' : '確定値'}
                  </span>
                  <span>対象 {preview.yearMonth}</span>
                  <span>突合 {preview.matchedCount} 冊</span>
                  <span>未突合 {preview.unknownAsinCount} 件</span>
                  <span>合計ロイヤリティ ¥{preview.totals.royalty_jpy.toLocaleString('ja-JP')}</span>
                  <span>販売 {preview.totals.units_sold.toLocaleString('ja-JP')} 部</span>
                  <span>KENP {preview.totals.kenp_read.toLocaleString('ja-JP')} ページ</span>
                  {preview.allocatedKenpRoyaltyJpy > 0 && (
                    <span className="text-muted">
                      うち KENP見込み ¥{preview.allocatedKenpRoyaltyJpy.toLocaleString('ja-JP')}（按分）
                    </span>
                  )}
                  {Object.keys(preview.unconvertedCurrencies).length > 0 && (
                    <span className="text-warning">
                      未換算通貨: {Object.entries(preview.unconvertedCurrencies).map(([c, n]) => `${c}×${n}`).join(', ')}
                    </span>
                  )}
                </div>
                {preview.monthsInFile.length > 1 && (
                  <p className="text-caption text-muted">
                    このファイルには複数月が含まれます（{preview.monthsInFile.join(', ')}）。取り込むのは対象年月 {preview.yearMonth} 分のみです。
                  </p>
                )}
                {preview.reportKind === 'estimate' && preview.totals.kenp_read > 0 && preview.allocatedKenpRoyaltyJpy === 0 && (
                  <p className="text-caption text-warning">
                    当月の KENP ロイヤリティ単価は月中は未確定のため、KENP分は ¥0 と表示されます（翌月に確定値レポートで取り込み直してください）。
                  </p>
                )}

                <div className="max-h-80 overflow-auto rounded-card border border-border-warm">
                  <table className="w-full text-caption">
                    <thead className="sticky top-0 bg-cream">
                      <tr className="text-left text-muted">
                        <th className="px-2 py-1 font-medium">ASIN</th>
                        <th className="px-2 py-1 font-medium">書籍</th>
                        <th className="px-2 py-1 text-right font-medium">ロイヤリティ</th>
                        <th className="px-2 py-1 text-right font-medium">販売</th>
                        <th className="px-2 py-1 text-right font-medium">KENP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((r) => (
                        <tr key={r.asin} className="border-t border-border-warm/60">
                          <td className="px-2 py-1 font-mono text-charcoal-82">{r.asin}</td>
                          <td className="px-2 py-1">
                            {r.bookId ? (
                              <span className="text-charcoal">{r.bookTitle ?? r.asin}</span>
                            ) : (
                              <span className="text-warning">未突合（{r.title ?? '不明'}）</span>
                            )}
                          </td>
                          <td className="px-2 py-1 text-right tabular-nums">¥{r.royalty_jpy.toLocaleString('ja-JP')}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{r.units_sold.toLocaleString('ja-JP')}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{r.kenp_read.toLocaleString('ja-JP')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center justify-end gap-space-snug">
                  <button
                    type="button"
                    onClick={handleCommit}
                    disabled={pending || preview.matchedCount === 0}
                    className="rounded-default bg-charcoal px-4 py-1.5 text-button-sm text-cream-light hover:opacity-90 disabled:opacity-50"
                    data-testid="sales-import-commit-btn"
                  >
                    {pending ? '取込中…' : `${preview.matchedCount} 冊を取り込む`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
