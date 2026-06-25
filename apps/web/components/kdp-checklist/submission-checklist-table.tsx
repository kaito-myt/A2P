'use client';

/**
 * SubmissionChecklistTable — S-015 メインテーブル (T-08-03, F-020/F-040).
 *
 * 列: チェック | フィールド名 | 値 | コピー | コメント
 * メタデータ未生成時は全行に未生成バナーを表示し、値は "—" になる。
 */
import { useTransition, useState } from 'react';

import { updateChecklist } from '@/app/actions/kdp-checklist';
import { messages } from '@/lib/messages';
import type { ChecklistBookView, ChecklistFieldView } from '@/lib/kdp-checklist-view';
import { CommentAffordance } from '@/components/comments/comment-affordance';

import { CopyToClipboardButton } from './copy-to-clipboard-button';

interface SubmissionChecklistTableProps {
  book: ChecklistBookView;
  onFieldUpdate: (
    bookId: string,
    field: string,
    patch: { copied?: boolean; checked?: boolean },
  ) => void;
}

const m = messages.kdpChecklist;

export function SubmissionChecklistTable({
  book,
  onFieldUpdate,
}: SubmissionChecklistTableProps) {
  if (book.metadataMissing) {
    return <MetadataMissingState />;
  }

  return (
    <div
      className="rounded-card border border-border-warm bg-cream-light"
      data-testid="submission-checklist-table"
    >
      {/* Desktop table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-body text-foreground">
          <thead>
            <tr className="border-b border-border-warm bg-cream">
              <th className="px-3 py-2 text-left text-button-sm text-muted">{m.columns.check}</th>
              <th className="px-3 py-2 text-left text-button-sm text-muted">{m.columns.fieldName}</th>
              <th className="px-3 py-2 text-left text-button-sm text-muted">{m.columns.value}</th>
              <th className="px-3 py-2 text-left text-button-sm text-muted">{m.columns.copy}</th>
              <th className="px-3 py-2 text-left text-button-sm text-muted">{m.columns.comment}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-warm">
            {book.fields.map((fieldView) => (
              <FieldRow
                key={fieldView.field}
                fieldView={fieldView}
                bookId={book.id}
                onFieldUpdate={onFieldUpdate}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile stacked rows */}
      <div className="flex flex-col divide-y divide-border-warm md:hidden">
        {book.fields.map((fieldView) => (
          <FieldRowMobile
            key={fieldView.field}
            fieldView={fieldView}
            bookId={book.id}
            onFieldUpdate={onFieldUpdate}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop row
// ---------------------------------------------------------------------------

interface FieldRowProps {
  fieldView: ChecklistFieldView;
  bookId: string;
  onFieldUpdate: SubmissionChecklistTableProps['onFieldUpdate'];
}

function FieldRow({ fieldView, bookId, onFieldUpdate }: FieldRowProps) {
  const [isPending, startTransition] = useTransition();
  const [optimisticChecked, setOptimisticChecked] = useState(fieldView.checked);

  // Sync when parent updates
  const isChecked = fieldView.checked || optimisticChecked;

  const handleCheck = (next: boolean) => {
    setOptimisticChecked(next);
    onFieldUpdate(bookId, fieldView.field, { checked: next });
    startTransition(async () => {
      await updateChecklist({ book_id: bookId, field: fieldView.field, checked: next });
    });
  };

  const handleCopied = () => {
    if (!isChecked) {
      setOptimisticChecked(true);
    }
    onFieldUpdate(bookId, fieldView.field, { copied: true, checked: true });
  };

  const value = fieldView.value;
  const isKeywords = fieldView.field === 'keywords';

  return (
    <tr
      className={`transition-colors ${isChecked ? 'bg-success-bg/40' : 'hover:bg-charcoal-04'}`}
      data-testid={`field-row-${fieldView.field}`}
    >
      {/* Checkbox */}
      <td className="px-3 py-2">
        <div className="flex min-h-[44px] items-center">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={isChecked}
              disabled={isPending}
              onChange={(e) => handleCheck(e.target.checked)}
              aria-label={m.checkboxAriaLabel(fieldView.label)}
              className="h-4 w-4 cursor-pointer accent-success"
              data-testid={`checkbox-${fieldView.field}`}
            />
          </label>
        </div>
      </td>

      {/* Field name */}
      <td className="px-3 py-2">
        <span className="text-button-sm font-medium text-charcoal">{fieldView.label}</span>
      </td>

      {/* Value */}
      <td className="max-w-xs px-3 py-2">
        {value === null ? (
          <span className="text-muted">{m.noValue}</span>
        ) : isKeywords && fieldView.keywords ? (
          <KeywordsChips keywords={fieldView.keywords} onCopied={handleCopied} />
        ) : fieldView.field === 'description' ? (
          <DescriptionCell value={value} />
        ) : fieldView.field === 'price' ? (
          <span>{formatPrice(value)}</span>
        ) : (
          <span className="break-all text-body">{value || m.noValue}</span>
        )}
      </td>

      {/* Copy button(s) */}
      <td className="px-3 py-2">
        <div className="flex items-center gap-1">
          {value !== null && (
            <CopyToClipboardButton
              bookId={bookId}
              field={fieldView.field}
              value={isKeywords && fieldView.keywords ? fieldView.keywords.join(' ') : value}
              onCopied={handleCopied}
              label={isKeywords ? m.keywordsBulkCopy : undefined}
              ariaLabel={isKeywords ? m.copyAllKeywordsAriaLabel : m.copyAriaLabel(fieldView.label)}
            />
          )}
          {(fieldView.field === 'cover_url' || fieldView.field === 'body_url') &&
            fieldView.downloadUrl && (
              <a
                href={fieldView.downloadUrl}
                download
                aria-label={m.downloadAriaLabel(fieldView.label)}
                className="inline-flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-card border border-border-warm bg-cream px-2 py-1 text-button-sm text-charcoal hover:bg-charcoal-04 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                data-testid={`download-btn-${fieldView.field}`}
              >
                <DownloadIcon />
              </a>
            )}
        </div>
      </td>

      {/* Comment affordance */}
      <td className="px-3 py-2">
        <CommentAffordance
          bookId={bookId}
          targetKind="metadata"
          targetId={bookId}
          anchorJson={{ field: fieldView.field }}
        />
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Mobile stacked row
// ---------------------------------------------------------------------------

function FieldRowMobile({ fieldView, bookId, onFieldUpdate }: FieldRowProps) {
  const [isPending, startTransition] = useTransition();
  const [optimisticChecked, setOptimisticChecked] = useState(fieldView.checked);
  const isChecked = fieldView.checked || optimisticChecked;

  const handleCheck = (next: boolean) => {
    setOptimisticChecked(next);
    onFieldUpdate(bookId, fieldView.field, { checked: next });
    startTransition(async () => {
      await updateChecklist({ book_id: bookId, field: fieldView.field, checked: next });
    });
  };

  const handleCopied = () => {
    if (!isChecked) setOptimisticChecked(true);
    onFieldUpdate(bookId, fieldView.field, { copied: true, checked: true });
  };

  const value = fieldView.value;
  const isKeywords = fieldView.field === 'keywords';

  return (
    <div
      className={`flex flex-col gap-1 p-space-snug ${isChecked ? 'bg-success-bg/40' : ''}`}
      data-testid={`field-row-mobile-${fieldView.field}`}
    >
      <div className="flex items-center justify-between gap-2">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={isChecked}
            disabled={isPending}
            onChange={(e) => handleCheck(e.target.checked)}
            aria-label={m.checkboxAriaLabel(fieldView.label)}
            className="h-4 w-4 cursor-pointer accent-success"
          />
          <span className="text-button-sm font-medium text-charcoal">{fieldView.label}</span>
        </label>
        <div className="flex items-center gap-1">
          {value !== null && (
            <CopyToClipboardButton
              bookId={bookId}
              field={fieldView.field}
              value={isKeywords && fieldView.keywords ? fieldView.keywords.join(' ') : value}
              onCopied={handleCopied}
              ariaLabel={m.copyAriaLabel(fieldView.label)}
            />
          )}
          <CommentAffordance
            bookId={bookId}
            targetKind="metadata"
            targetId={bookId}
            anchorJson={{ field: fieldView.field }}
          />
        </div>
      </div>

      <div className="pl-6 text-body text-foreground">
        {value === null ? (
          <span className="text-muted">{m.noValue}</span>
        ) : isKeywords && fieldView.keywords ? (
          <KeywordsChips keywords={fieldView.keywords} onCopied={handleCopied} />
        ) : fieldView.field === 'description' ? (
          <DescriptionCell value={value} />
        ) : fieldView.field === 'price' ? (
          <span>{formatPrice(value)}</span>
        ) : (
          <span className="break-all">{value || m.noValue}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function KeywordsChips({
  keywords,
  onCopied,
}: {
  keywords: string[];
  /** いずれかのキーワードがコピーされたら親へ通知 (copied/checked を立てる) */
  onCopied?: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap gap-1">
        {keywords.map((kw) => (
          <KeywordChip key={kw} keyword={kw} onCopied={onCopied} />
        ))}
      </div>
      <span className="text-caption text-muted">{m.keywordCopyHint}</span>
    </div>
  );
}

/** 1 語だけクリップボードにコピーするチップ (KDP はキーワードを 1 枠ずつ入力する)。 */
function KeywordChip({ keyword, onCopied }: { keyword: string; onCopied?: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(keyword);
      setCopied(true);
      onCopied?.();
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // insecure context — silent
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={m.copyKeywordAriaLabel(keyword)}
      data-testid={`keyword-chip-${keyword}`}
      className={`inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-caption transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        copied
          ? 'border-success bg-success-bg/40 text-success'
          : 'border-border-warm bg-cream text-charcoal hover:bg-charcoal-04'
      }`}
    >
      <span>{keyword}</span>
      <span aria-hidden="true" className="text-muted">
        {copied ? '✓' : '⧉'}
      </span>
    </button>
  );
}

function DescriptionCell({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  const m = messages.kdpChecklist;
  const TRUNCATE_LINES = 3;
  const isTruncatable = value.split('\n').length > TRUNCATE_LINES || value.length > 200;

  return (
    <div>
      <p
        className={`text-body ${!expanded && isTruncatable ? 'line-clamp-3' : ''}`}
      >
        {value}
      </p>
      {isTruncatable && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-caption text-accent underline underline-offset-4 hover:opacity-80"
        >
          {expanded ? m.descriptionCollapse : m.descriptionExpand}
        </button>
      )}
    </div>
  );
}

function MetadataMissingState() {
  const m = messages.kdpChecklist;
  return (
    <div
      className="flex flex-col items-center gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
      data-testid="metadata-missing-state"
      role="alert"
    >
      <p className="text-body font-medium text-charcoal">{m.metadataMissingBanner}</p>
      <button
        type="button"
        className="inline-flex cursor-not-allowed items-center rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-muted opacity-50"
        disabled
        title="Phase 2 で実装予定"
      >
        {m.metadataRegenerate}
      </button>
    </div>
  );
}

function formatPrice(value: string): string {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return value;
  return `¥${n.toLocaleString('ja-JP')}`;
}

function DownloadIcon() {
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
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  );
}
