'use client';

/**
 * PayloadJsonViewer — payload_json 折りたたみ JSON ビューア (S-026, T-09-02).
 *
 * 全展開 / 折りたたみ / クリップボードへコピー の 3 ボタン。
 * Phase 1 では <pre> pretty-print。インタラクティブなツリーは Phase 2 以降。
 * 仕様根拠: docs/wireframes/S-026-job-detail/prompt.md §Section 3
 */
import { useState, useCallback } from 'react';
import { Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';

import { messages } from '@/lib/messages';

const m = messages.jobs.detail;

interface PayloadJsonViewerProps {
  payload: unknown;
}

export function PayloadJsonViewer({ payload }: PayloadJsonViewerProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);

  const prettyJson = JSON.stringify(payload, null, 2);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(prettyJson);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard write may fail in non-secure contexts; silently ignore
    }
  }, [prettyJson]);

  return (
    <section aria-label={m.payloadSection} className="rounded-card border border-border-warm bg-white">
      <div className="flex items-center justify-between border-b border-border-warm px-space-normal py-space-snug">
        <button
          type="button"
          className="flex items-center gap-1.5 text-body font-medium text-foreground hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-controls="payload-json-content"
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          )}
          {m.payloadSection}
        </button>

        <div className="flex items-center gap-2" aria-label="ペイロード操作">
          <button
            type="button"
            className="rounded px-2 py-0.5 text-caption text-muted hover:bg-cream-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => setCollapsed(false)}
            aria-label={m.expandAll}
          >
            {m.expandAll}
          </button>
          <button
            type="button"
            className="rounded px-2 py-0.5 text-caption text-muted hover:bg-cream-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => setCollapsed(true)}
            aria-label={m.collapseAll}
          >
            {m.collapseAll}
          </button>
          <button
            type="button"
            className="flex items-center gap-1 rounded px-2 py-0.5 text-caption text-muted hover:bg-cream-light focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            onClick={handleCopy}
            aria-label={copied ? m.copied : m.copyClipboard}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-600" aria-hidden="true" />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>{copied ? m.copied : m.copyClipboard}</span>
          </button>
        </div>
      </div>

      {!collapsed && (
        <div id="payload-json-content">
          <pre
            className="overflow-x-auto p-space-normal text-caption leading-relaxed text-foreground"
            style={{ fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
          >
            {prettyJson}
          </pre>
        </div>
      )}
    </section>
  );
}
