/**
 * AssignmentHistoryTable (S-019) — 全 ModelAssignment の履歴一覧.
 *
 * RSC ではなく "Server Component as default" の React component。
 * page.tsx で Prisma の Date を ISO 文字列化したシリアライズ済み行を受け取る。
 *
 * archived 行のみ「過去版に戻す」ボタンを描画 (Client island)。
 */
import { messages } from '@/lib/messages';
import type { AssignmentRowSerialized } from '@/lib/model-assignments-view';

import { AssignmentRevertButton } from './assignment-revert-button';

interface Props {
  rows: readonly AssignmentRowSerialized[];
}

function formatDateTime(iso: string | null): string {
  if (iso === null) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

export function AssignmentHistoryTable({ rows }: Props) {
  const m = messages.modelAssignments;

  return (
    <section className="flex flex-col gap-space-snug">
      <header className="flex flex-col">
        <h2 className="text-card-title text-foreground">{m.history.sectionTitle}</h2>
        <p className="text-body text-muted">{m.history.sectionHint}</p>
      </header>

      {rows.length === 0 ? (
        <div
          data-testid="assignment-history-table"
          className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center text-body text-muted"
        >
          {m.history.empty}
        </div>
      ) : (
        <div
          data-testid="assignment-history-table"
          className="overflow-x-auto rounded-card border border-border-warm"
        >
          <table className="w-full border-collapse text-body">
            <thead className="bg-charcoal-04">
              <tr>
                <Th>{m.history.role}</Th>
                <Th>{m.history.genre}</Th>
                <Th>{m.history.providerModel}</Th>
                <Th>{m.history.activatedAt}</Th>
                <Th>{m.history.archivedAt}</Th>
                <Th>{m.history.createdBy}</Th>
                <Th>{m.history.status}</Th>
                <Th align="right">{m.history.actions}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const roleLabel = (m.roles as Record<string, string>)[r.role] ?? r.role;
                const genreLabel =
                  r.genre === null
                    ? m.history.genreDefault
                    : (m.genres as Record<string, string>)[r.genre] ?? r.genre;
                const providerLabel =
                  (m.providers as Record<string, string>)[r.provider] ?? r.provider;
                const statusLabel =
                  r.status === 'active' ? m.history.statusActive : m.history.statusArchived;
                return (
                  <tr key={r.id} className="border-t border-border-warm">
                    <Td>{roleLabel}</Td>
                    <Td>{genreLabel}</Td>
                    <Td>
                      {providerLabel} / {r.model}
                    </Td>
                    <Td>{formatDateTime(r.activated_at)}</Td>
                    <Td>{formatDateTime(r.archived_at)}</Td>
                    <Td>{r.created_by}</Td>
                    <Td>{statusLabel}</Td>
                    <Td align="right">
                      {r.status === 'archived' ? (
                        <AssignmentRevertButton assignmentId={r.id} />
                      ) : (
                        <span className="text-button-sm text-muted">—</span>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={`px-space-relaxed py-2 text-button-sm font-normal text-charcoal-82 ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <td
      className={`px-space-relaxed py-3 text-body align-middle ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </td>
  );
}
