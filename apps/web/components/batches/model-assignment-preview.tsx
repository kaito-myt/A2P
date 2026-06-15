/**
 * S-008 モデル割当プレビュー (T-03-09, RSC).
 *
 * 各 role の現在 active な ModelAssignment を表示。未設定があれば警告メッセージ。
 * 詳細編集リンクは S-019 へ。SP-04 で「この実行だけ上書き」フォームを追加する。
 */
import Link from 'next/link';

import { messages } from '@/lib/messages';

const m = messages.batches.modelPreview;

export interface ModelAssignmentPreviewRow {
  role: string;
  provider: string | null;
  model: string | null;
}

interface ModelAssignmentPreviewProps {
  rows: readonly ModelAssignmentPreviewRow[];
}

function roleLabel(role: string): string {
  const labels: Record<string, string> = m.roles;
  return labels[role] ?? role;
}

export function ModelAssignmentPreview({ rows }: ModelAssignmentPreviewProps) {
  const missingRoles = rows.filter((r) => r.provider === null || r.model === null);

  return (
    <section
      data-testid="model-assignment-preview"
      className="rounded-card border border-border-warm bg-cream"
    >
      <header className="flex items-center justify-between px-space-loose pt-space-loose">
        <div className="flex flex-col">
          <h2 className="text-card-title text-foreground">{m.sectionTitle}</h2>
          <p className="text-caption text-muted">{m.sectionHint}</p>
        </div>
        <Link
          href="/models/assignments"
          className="text-button-sm text-foreground underline hover:no-underline"
        >
          {m.editLink}
        </Link>
      </header>
      <div className="px-space-loose pb-space-loose pt-space-snug">
        {missingRoles.length > 0 && (
          <p
            data-testid="model-preview-missing-warning"
            className="mb-space-snug rounded-default border border-destructive bg-destructive-bg px-3 py-2 text-button-sm text-destructive"
          >
            {m.missingWarning}
          </p>
        )}
        <table className="w-full border-collapse text-button-sm">
          <thead>
            <tr className="border-b border-border-warm text-left text-muted">
              <th className="py-2 pr-3 font-medium">{m.colRole}</th>
              <th className="py-2 pr-3 font-medium">{m.colProvider}</th>
              <th className="py-2 pr-3 font-medium">{m.colModel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const unset = r.provider === null || r.model === null;
              return (
                <tr
                  key={r.role}
                  data-testid={`model-preview-row-${r.role}`}
                  className="border-b border-border-warm/60 last:border-b-0"
                >
                  <td className="py-2 pr-3 font-medium text-foreground">
                    {roleLabel(r.role)}
                  </td>
                  <td className="py-2 pr-3 text-charcoal-82">
                    {unset ? m.unset : r.provider}
                  </td>
                  <td className="py-2 pr-3 text-charcoal-82">
                    {unset ? m.unset : r.model}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
