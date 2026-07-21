'use client';

/**
 * S-013 CommentsTable (T-06-06).
 *
 * Grouped table with checkbox selection.
 * Only pending rows are selectable.
 */
import { Badge } from '@/components/ui/badge';
import { messages } from '@/lib/messages';
import type { CommentRowSerialized, CommentGroup } from '@/lib/comments-view';
import { formatDateTime } from '@/lib/comments-view';
import {
  commentStatusLabel,
  commentStatusVariant,
  type CommentPriority,
} from '@/lib/comment-helpers';

const m = messages.commentsPage.table;
const targetKindLabels: Record<string, string> = {
  chapter: messages.commentsPage.filter.targetKindChapter,
  outline: messages.commentsPage.filter.targetKindOutline,
  cover: messages.commentsPage.filter.targetKindCover,
  cover_text: messages.commentsPage.filter.targetKindCoverText,
  metadata: messages.commentsPage.filter.targetKindMetadata,
  theme: messages.commentsPage.filter.targetKindTheme,
};

interface CommentsTableProps {
  groups: CommentGroup[];
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** 指定した未消化コメント群の選択を一括で切り替える (グループ単位の全選択に使用)。 */
  onToggleGroup: (ids: string[], selectAll: boolean) => void;
}

export function CommentsTable({
  groups,
  selectedIds,
  onToggle,
  onToggleGroup,
}: CommentsTableProps) {
  const totalRows = groups.reduce((sum, g) => sum + g.rows.length, 0);

  if (totalRows === 0) {
    return (
      <div
        data-testid="comments-table-empty"
        className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
      >
        <p className="text-body text-muted">{m.noResults}</p>
      </div>
    );
  }

  return (
    <div data-testid="comments-table" className="flex flex-col gap-space-snug">
      {groups.map((group) => {
        const groupPendingIds = group.rows
          .filter((r) => r.status === 'pending')
          .map((r) => r.id);
        const groupSelectedCount = groupPendingIds.filter((id) => selectedIds.has(id)).length;
        const groupAllSelected =
          groupPendingIds.length > 0 && groupSelectedCount === groupPendingIds.length;

        return (
          <div key={group.key} className="flex flex-col gap-1">
            <h3
              data-testid={`group-heading-${group.key}`}
              className="text-button font-medium text-charcoal-82"
            >
              {group.label}
              <span className="ml-2 text-button-sm text-muted">
                ({group.rows.length})
              </span>
              {groupSelectedCount > 0 && (
                <span className="ml-2 text-button-sm text-accent">
                  {m.groupSelectedCount(groupSelectedCount)}
                </span>
              )}
            </h3>
            <div className="overflow-x-auto rounded-card border border-border-warm">
              <table className="w-full text-left text-button-sm">
                <thead>
                  <tr className="border-b border-border-warm bg-cream">
                    <th className="w-10 px-3 py-2">
                      {groupPendingIds.length > 0 && (
                        <input
                          type="checkbox"
                          checked={groupAllSelected}
                          onChange={(e) => onToggleGroup(groupPendingIds, e.target.checked)}
                          aria-label={m.selectGroupAria}
                          title={m.selectGroupAria}
                          className="h-4 w-4 rounded border-charcoal-40"
                          data-testid={`select-group-checkbox-${group.key}`}
                        />
                      )}
                    </th>
                    <th className="px-3 py-2 font-medium text-muted">{m.bookTitle}</th>
                    <th className="px-3 py-2 font-medium text-muted">{m.targetKind}</th>
                    <th className="px-3 py-2 font-medium text-muted">{m.body}</th>
                    <th className="px-3 py-2 font-medium text-muted">{m.priority}</th>
                    <th className="px-3 py-2 font-medium text-muted">{m.status}</th>
                    <th className="px-3 py-2 font-medium text-muted">{m.createdAt}</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <CommentTableRow
                      key={row.id}
                      row={row}
                      checked={selectedIds.has(row.id)}
                      onToggle={onToggle}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface CommentTableRowProps {
  row: CommentRowSerialized;
  checked: boolean;
  onToggle: (id: string) => void;
}

function CommentTableRow({ row, checked, onToggle }: CommentTableRowProps) {
  const isPending = row.status === 'pending';
  const bodySnippet =
    row.body.length > 80 ? row.body.slice(0, 80) + '...' : row.body;

  return (
    <tr
      data-testid={`comment-row-${row.id}`}
      className="border-b border-border-warm last:border-b-0 hover:bg-charcoal-04"
    >
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={checked}
          disabled={!isPending}
          onChange={() => onToggle(row.id)}
          aria-label={`select comment ${row.id}`}
          className="h-4 w-4 rounded border-charcoal-40 disabled:opacity-40"
          data-testid={`comment-checkbox-${row.id}`}
        />
      </td>
      <td className="px-3 py-2 text-charcoal">{row.book_title}</td>
      <td className="px-3 py-2">
        {targetKindLabels[row.target_kind] ?? row.target_kind}
      </td>
      <td className="max-w-xs truncate px-3 py-2 text-charcoal" title={row.body}>
        {bodySnippet}
      </td>
      <td className="px-3 py-2">
        <Badge variant={row.priority as CommentPriority}>
          {row.priority}
        </Badge>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col gap-0.5">
          <Badge variant={commentStatusVariant(row.status)} data-testid={`comment-status-${row.id}`}>
            {commentStatusLabel(row.status)}
          </Badge>
          {row.status === 'applied' && row.applied_at && (
            <span className="whitespace-nowrap text-caption text-muted">
              {formatDateTime(row.applied_at)}
            </span>
          )}
        </div>
      </td>
      <td className="whitespace-nowrap px-3 py-2 text-muted">
        {formatDateTime(row.created_at)}
      </td>
    </tr>
  );
}
