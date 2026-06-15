'use client';

/**
 * JsonDiffExpander — S-029 監査ログの行展開コンポーネント (T-09-03, F-030).
 *
 * before_json (左) / after_json (右) を side-by-side で表示し、
 * 変更キーを +/− でハイライト。
 * before_json が null の場合（新規作成）は gracefully 処理。
 *
 * 仕様根拠: docs/wireframes/S-029-audit-log/prompt.md §Section 4
 */

import { useState, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';

import { messages } from '@/lib/messages';
import { computeJsonDiff, type DiffEntry, type DiffKind } from '@/lib/audit-view';

const m = messages.audit.diff;

interface JsonDiffExpanderProps {
  beforeJson: unknown | null;
  afterJson: unknown | null;
  actorLabel: string;
  createdAt: string;
}

export function JsonDiffExpander({
  beforeJson,
  afterJson,
  actorLabel,
  createdAt,
}: JsonDiffExpanderProps) {
  const diffEntries = computeJsonDiff(beforeJson, afterJson);
  const hasChanges = diffEntries.some((d) => d.kind !== 'unchanged');

  const formattedBefore = beforeJson !== null ? JSON.stringify(beforeJson, null, 2) : null;
  const formattedAfter = afterJson !== null ? JSON.stringify(afterJson, null, 2) : null;

  return (
    <div
      className="border-t border-border-warm bg-cream-light px-space-normal py-space-snug"
      data-testid="json-diff-expander"
    >
      {/* Meta row */}
      <div className="mb-space-snug flex flex-wrap gap-space-relaxed text-caption text-muted">
        <span>
          <span className="font-medium">{m.actorDetail}:</span> {actorLabel}
        </span>
        <span>
          <span className="font-medium">{m.createdAt}:</span>{' '}
          <time dateTime={createdAt} className="tabular-nums">
            {new Date(createdAt).toLocaleString('ja-JP', {
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </time>
        </span>
      </div>

      {/* Legend */}
      <div className="mb-space-snug flex gap-3 text-caption">
        <span className="flex items-center gap-1">
          <span className="font-mono text-green-700">+</span>
          <span className="text-muted">追加</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="font-mono text-red-700">−</span>
          <span className="text-muted">削除</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="font-mono text-amber-700">~</span>
          <span className="text-muted">変更</span>
        </span>
      </div>

      {/* Diff grid */}
      {hasChanges || beforeJson !== null || afterJson !== null ? (
        <div className="flex flex-col gap-space-snug md:flex-row md:gap-space-normal">
          {/* Before */}
          <JsonPane
            label={m.beforeLabel}
            content={formattedBefore}
            nullLabel={m.nullBefore}
            side="before"
            diffEntries={diffEntries}
          />
          {/* After */}
          <JsonPane
            label={m.afterLabel}
            content={formattedAfter}
            nullLabel={m.nullAfter}
            side="after"
            diffEntries={diffEntries}
          />
        </div>
      ) : (
        <p className="text-body text-muted">{m.noChanges}</p>
      )}
    </div>
  );
}

interface JsonPaneProps {
  label: string;
  content: string | null;
  nullLabel: string;
  side: 'before' | 'after';
  diffEntries: DiffEntry[];
}

function JsonPane({ label, content, nullLabel, side, diffEntries }: JsonPaneProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard write may fail in non-secure contexts
    }
  }, [content]);

  const copyLabel = side === 'before' ? m.copyBefore : m.copyAfter;

  return (
    <div className="min-w-0 flex-1 rounded-card border border-border-warm bg-white">
      {/* Pane header */}
      <div className="flex items-center justify-between border-b border-border-warm px-space-snug py-1.5">
        <span className="text-caption font-medium text-charcoal">{label}</span>
        {content !== null && (
          <button
            type="button"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-caption text-muted hover:bg-cream-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={handleCopy}
            aria-label={copied ? m.copied : copyLabel}
          >
            {copied ? (
              <Check className="h-3 w-3 text-green-600" aria-hidden="true" />
            ) : (
              <Copy className="h-3 w-3" aria-hidden="true" />
            )}
            <span>{copied ? m.copied : copyLabel.split(' ')[0]}</span>
          </button>
        )}
      </div>

      {/* JSON content */}
      {content === null ? (
        <p className="px-space-snug py-space-normal text-caption italic text-muted">{nullLabel}</p>
      ) : (
        <DiffHighlightedPre
          content={content}
          side={side}
          diffEntries={diffEntries}
        />
      )}
    </div>
  );
}

interface DiffHighlightedPreProps {
  content: string;
  side: 'before' | 'after';
  diffEntries: DiffEntry[];
}

function diffKindForLine(line: string, side: 'before' | 'after', diffEntries: DiffEntry[]): DiffKind | null {
  // Try to match a key in the line like `  "key":`
  const keyMatch = line.match(/^\s+"([^"]+)"\s*:/);
  if (!keyMatch) return null;
  const key = keyMatch[1]!;
  const entry = diffEntries.find((d) => d.key === key);
  if (!entry) return null;
  if (entry.kind === 'unchanged') return null;
  if (entry.kind === 'added' && side === 'after') return 'added';
  if (entry.kind === 'removed' && side === 'before') return 'removed';
  if (entry.kind === 'changed') return 'changed';
  return null;
}

function lineStyle(kind: DiffKind | null): string {
  switch (kind) {
    case 'added':
      return 'bg-green-50 text-green-800';
    case 'removed':
      return 'bg-red-50 text-red-800';
    case 'changed':
      return 'bg-amber-50 text-amber-900';
    default:
      return '';
  }
}

function linePrefix(kind: DiffKind | null, side: 'before' | 'after'): string {
  if (kind === 'added') return '+';
  if (kind === 'removed') return '−';
  if (kind === 'changed') return '~';
  // For added entries: the before side shows nothing, but we still show the key in after
  // Return empty space for alignment
  return ' ';
}

function DiffHighlightedPre({ content, side, diffEntries }: DiffHighlightedPreProps) {
  const lines = content.split('\n');

  return (
    <div
      className="overflow-x-auto"
      role="region"
      aria-label={side === 'before' ? 'before JSON' : 'after JSON'}
    >
      <pre
        className="p-space-snug text-caption leading-relaxed"
        style={{ fontFamily: 'monospace', margin: 0 }}
      >
        {lines.map((line, i) => {
          const kind = diffKindForLine(line, side, diffEntries);
          const prefix = linePrefix(kind, side);
          return (
            <div
              key={i}
              className={`flex ${lineStyle(kind)}`}
              aria-label={kind ? `${kind} key` : undefined}
            >
              <span
                className="select-none pr-1 font-mono text-[10px] opacity-60 tabular-nums"
                aria-hidden="true"
                style={{ minWidth: '1rem' }}
              >
                {prefix}
              </span>
              <span>{line}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
