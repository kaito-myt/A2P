'use client';

/**
 * CsvImportPanel — CSV 一括インポートパネル (S-018, T-08-06).
 *
 * - テンプレート CSV クライアントサイドダウンロード
 * - ファイルピッカー / ドロップゾーン (keyboard-accessible)
 * - プレビュー (折りたたみ)
 * - importSalesCsv SA 呼び出し
 * - 行番号付きエラーバナー
 *
 * 仕様根拠: docs/04 S-018 / SP-08 T-08-06
 */
import { useState, useRef, useCallback, useId } from 'react';
import { Upload, Download, AlertCircle } from 'lucide-react';

import { messages } from '@/lib/messages';
import { importSalesCsv } from '@/app/actions/sales';
import {
  buildSalesTemplateCsv,
  buildSalesTemplateCsvFilename,
} from '@/lib/sales-view';
import type { ImportSalesCsvResult } from '@/lib/sales-core';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

const m = messages.salesManual.csv;

interface CsvImportState {
  file: File | null;
  csvText: string | null;
  previewRows: string[][];
  isOpen: boolean;
  isDragOver: boolean;
  isPending: boolean;
  result: ImportSalesCsvResult | null;
  successMessage: string | null;
  formError: string | null;
}

const INITIAL_STATE: CsvImportState = {
  file: null,
  csvText: null,
  previewRows: [],
  isOpen: false,
  isDragOver: false,
  isPending: false,
  result: null,
  successMessage: null,
  formError: null,
};

const CSV_PREVIEW_LIMIT = 6; // header + 5 data rows

export function CsvImportPanel() {
  const sectionId = useId();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<CsvImportState>(INITIAL_STATE);

  function patchState(patch: Partial<CsvImportState>) {
    setState((prev) => ({ ...prev, ...patch }));
  }

  function handleTemplateDownload() {
    const csv = buildSalesTemplateCsv();
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = buildSalesTemplateCsvFilename();
    a.click();
    URL.revokeObjectURL(url);
  }

  const loadFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result;
      if (typeof text !== 'string') return;
      // Parse first N rows for preview
      const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
      const previewRows = lines.slice(0, CSV_PREVIEW_LIMIT).map((line) =>
        line.split(',').map((cell) => cell.replace(/^"|"$/g, '').replace(/""/g, '"')),
      );
      patchState({
        file,
        csvText: text,
        previewRows,
        result: null,
        successMessage: null,
        formError: null,
      });
    };
    reader.readAsText(file);
  }, []);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
    // reset so same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    patchState({ isDragOver: true });
  }

  function handleDragLeave() {
    patchState({ isDragOver: false });
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    patchState({ isDragOver: false });
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  }

  function handleDropAreaKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInputRef.current?.click();
    }
  }

  async function handleImport() {
    if (!state.csvText) return;
    patchState({ isPending: true, formError: null, successMessage: null, result: null });

    try {
      const result = await importSalesCsv({ csv: state.csvText });
      if (!result.ok) {
        patchState({ formError: result.error.message ?? messages.salesManual.errors.unknown, isPending: false });
        return;
      }
      const data = result.data;
      const imported = data.inserted + data.updated;
      const successMsg = data.errors.length > 0
        ? m.importPartial(imported, data.errors.length)
        : m.importSuccess(imported);
      patchState({
        result: data,
        successMessage: successMsg,
        isPending: false,
      });
    } catch {
      patchState({ formError: messages.salesManual.errors.unknown, isPending: false });
    }
  }

  const hasErrors = (state.result?.errors.length ?? 0) > 0;
  const errorCount = state.result?.errors.length ?? 0;

  return (
    <section
      className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-surface p-4"
      aria-labelledby={`${sectionId}-heading`}
      data-testid="csv-import-panel"
    >
      <h2 id={`${sectionId}-heading`} className="text-label text-foreground">
        {m.sectionTitle}
      </h2>

      {/* Template download */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleTemplateDownload}
        className="flex w-fit items-center gap-2"
        data-testid="download-template-button"
      >
        <Download size={14} aria-hidden="true" />
        {m.downloadTemplate}
      </Button>

      {/* Drop area */}
      <div
        role="button"
        tabIndex={0}
        aria-label={m.dropAreaAriaLabel}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onKeyDown={handleDropAreaKeyDown}
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed px-4 py-8',
          'text-body-sm text-muted transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          state.isDragOver
            ? 'border-charcoal bg-charcoal-04'
            : 'border-border-warm hover:border-charcoal-40 hover:bg-charcoal-04',
        )}
        data-testid="csv-drop-area"
      >
        <Upload size={24} aria-hidden="true" className="text-muted" />
        {state.file ? (
          <span className="font-medium text-charcoal">{m.fileSelected(state.file.name)}</span>
        ) : (
          <span>{m.dropAreaLabel}</span>
        )}
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        id={fileInputId}
        type="file"
        accept=".csv,text/csv"
        onChange={handleFileChange}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        data-testid="csv-file-input"
      />

      {/* Preview (collapsible) */}
      {state.previewRows.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => patchState({ isOpen: !state.isOpen })}
            aria-expanded={state.isOpen}
            className="flex items-center gap-1 text-button-sm text-charcoal hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {state.isOpen ? m.previewToggleClose : m.previewToggleOpen}
            <ChevronIcon open={state.isOpen} />
          </button>
          {state.isOpen && (
            <div className="overflow-x-auto">
              <table className="w-full text-body-sm" data-testid="csv-preview-table">
                <tbody>
                  {state.previewRows.map((row, ri) => (
                    <tr key={ri} className={cn('border-b border-border-warm/50', ri === 0 && 'font-medium text-muted')}>
                      <td className="pr-2 py-1 text-muted">{ri + 1}</td>
                      {row.map((cell, ci) => (
                        <td key={ci} className="pr-3 py-1 text-charcoal">{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <p className="text-body-sm text-muted">{m.previewNote}</p>

      {/* Form error */}
      {state.formError && (
        <div role="alert" className="flex items-start gap-2 rounded-card border border-destructive/40 bg-destructive/10 px-3 py-2 text-body-sm text-destructive">
          <AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
          {state.formError}
        </div>
      )}

      {/* Success */}
      {state.successMessage && (
        <div role="status" aria-live="polite" className="rounded-card border border-green-300 bg-green-50 px-3 py-2 text-body-sm text-green-800">
          {state.successMessage}
        </div>
      )}

      {/* Error list */}
      {hasErrors && (
        <div
          role="alert"
          className="rounded-card border border-destructive/40 bg-destructive/10 p-3 text-body-sm"
          data-testid="csv-error-list"
        >
          <div className="mb-2 flex items-center gap-2 font-medium text-destructive">
            <AlertCircle size={16} aria-hidden="true" />
            {m.errorBannerTitle(errorCount)}
          </div>
          <ul className="space-y-1 text-destructive">
            {state.result!.errors.map((e) => (
              <li key={e.row}>
                <span className="font-medium">{m.errorRowPrefix(e.row)}:</span> {e.message}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-muted">{m.reuploadHint}</p>
        </div>
      )}

      {/* Import button */}
      <Button
        type="button"
        disabled={!state.file || state.isPending}
        onClick={handleImport}
        className="flex w-fit items-center gap-2"
        data-testid="import-button"
      >
        <Upload size={16} aria-hidden="true" />
        {state.isPending ? messages.salesManual.csv.importing : messages.salesManual.csv.importButton}
      </Button>
    </section>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn('shrink-0 text-muted transition-transform', open && 'rotate-180')}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
