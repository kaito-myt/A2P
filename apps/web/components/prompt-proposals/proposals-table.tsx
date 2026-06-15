'use client';

/**
 * ProposalsTable — S-023 提案一覧テーブル (T-11-07).
 *
 * 列: 役割 / ジャンル / 現行 → 提案バージョン / 期待効果 / ステータス / 生成日時
 * 行クリック → URL ?id=... でルーター更新（親 RSC が ProposalDetail を表示）
 *
 * data-testid: proposals-table / proposal-row-{id} / proposal-status-{id}
 */
import { useRouter, useSearchParams } from 'next/navigation';

import { messages } from '@/lib/messages';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import type { ProposalListItem } from '@/lib/prompt-proposals-view';

const m = messages.promptProposals;
const mt = m.table;

interface ProposalsTableProps {
  proposals: ProposalListItem[];
}

export function ProposalsTable({ proposals }: ProposalsTableProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get('id');

  const handleRowClick = (id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('id', id);
    router.push(`?${params.toString()}`);
  };

  return (
    <div data-testid="proposals-table" className="flex flex-col">
      <div className="overflow-x-auto rounded-card border border-border-warm">
        <table className="w-full text-left text-button-sm">
          <thead className="border-b border-border-warm bg-cream-light">
            <tr>
              <th className="px-3 py-2 font-medium text-muted">{mt.colRole}</th>
              <th className="px-3 py-2 font-medium text-muted">{mt.colGenre}</th>
              <th className="px-3 py-2 font-medium text-muted">{mt.colVersion}</th>
              <th className="px-3 py-2 font-medium text-muted">{mt.colStatus}</th>
              <th className="px-3 py-2 font-medium text-muted">{mt.colCreatedAt}</th>
            </tr>
          </thead>
          <tbody>
            {proposals.map((p) => (
              <tr
                key={p.id}
                data-testid={`proposal-row-${p.id}`}
                onClick={() => handleRowClick(p.id)}
                className={cn(
                  'cursor-pointer border-b border-border-warm transition-colors last:border-0',
                  p.id === selectedId
                    ? 'bg-charcoal-04'
                    : 'hover:bg-cream-light',
                )}
              >
                <td className="px-3 py-2 text-charcoal">{p.role}</td>
                <td className="px-3 py-2 text-charcoal">
                  {p.genre ?? mt.genreDefault}
                </td>
                <td className="px-3 py-2 text-charcoal">
                  {mt.versionLabel(p.source_version, p.source_version + 1)}
                </td>
                <td className="px-3 py-2" data-testid={`proposal-status-${p.id}`}>
                  <ProposalStatusBadge status={p.status} />
                </td>
                <td className="px-3 py-2 text-muted">
                  {formatDate(p.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProposalStatusBadge({ status }: { status: string }) {
  const label = m.status[status] ?? status;
  if (status === 'pending') return <Badge variant="neutral">{label}</Badge>;
  if (status === 'approved' || status === 'auto_approved') return <Badge variant="success">{label}</Badge>;
  if (status === 'rejected') return <Badge variant="must">{label}</Badge>;
  return <Badge variant="neutral">{label}</Badge>;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
