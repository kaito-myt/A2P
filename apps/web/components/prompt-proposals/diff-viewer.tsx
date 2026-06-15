'use client';

/**
 * DiffViewer — S-023 プロンプト diff 表示 (T-11-07).
 *
 * unified diff 形式文字列 (proposed_body と source_prompt_body の行差分) を
 * + / - 行カラーリングで表示する。
 *
 * 仕様: SP-11 T-11-07 §3 diff-viewer.tsx — unified diff の +/- 行カラーリング、等幅。
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { messages } from '@/lib/messages';

const m = messages.promptProposals.detail;

interface DiffViewerProps {
  /** unified diff 文字列 (proposed_body の行差分) */
  diff: string;
  sourceVersion: number;
  proposedVersion: number;
}

export function DiffViewer({ diff, sourceVersion, proposedVersion }: DiffViewerProps) {
  const lines = diff.split('\n');

  return (
    <Card data-testid="diff-viewer">
      <CardHeader>
        <CardTitle className="text-card-title">{m.diffSectionTitle}</CardTitle>
        <div className="flex gap-4 text-caption text-muted">
          <span>{m.diffOldLabel(sourceVersion)}</span>
          <span>→</span>
          <span>{m.diffNewLabel(proposedVersion)}</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto rounded-default border border-border-warm">
          <div className="font-mono text-caption leading-relaxed" data-testid="diff-lines">
            {lines.map((line, i) => (
              <DiffLine key={i} line={line} />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DiffLine({ line }: { line: string }) {
  if (line.startsWith('+') && !line.startsWith('+++')) {
    return (
      <div
        className={cn('whitespace-pre px-3 py-0.5 text-success', 'bg-success-bg')}
        data-testid="diff-line-added"
      >
        {line}
      </div>
    );
  }
  if (line.startsWith('-') && !line.startsWith('---')) {
    return (
      <div
        className={cn('whitespace-pre px-3 py-0.5 text-destructive', 'bg-destructive-bg')}
        data-testid="diff-line-removed"
      >
        {line}
      </div>
    );
  }
  if (line.startsWith('@@')) {
    return (
      <div className="whitespace-pre bg-charcoal-04 px-3 py-0.5 text-caption text-charcoal-60">
        {line}
      </div>
    );
  }
  return (
    <div className="whitespace-pre px-3 py-0.5 text-charcoal-82">
      {line || ' '}
    </div>
  );
}
