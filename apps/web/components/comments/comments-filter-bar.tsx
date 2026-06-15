'use client';

/**
 * S-013 CommentsFilterBar (T-06-06).
 *
 * Filter controls: status, priority, target_kind, book.
 * Grouping toggle: book / target_kind / priority.
 */
import { messages } from '@/lib/messages';
import type { CommentsPageFilter, GroupByKey, BookOption } from '@/lib/comments-view';

const m = messages.commentsPage;

interface CommentsFilterBarProps {
  filter: CommentsPageFilter;
  onFilterChange: (key: keyof CommentsPageFilter, value: string | undefined) => void;
  groupBy: GroupByKey;
  onGroupByChange: (groupBy: GroupByKey) => void;
  bookOptions: BookOption[];
}

export function CommentsFilterBar({
  filter,
  onFilterChange,
  groupBy,
  onGroupByChange,
  bookOptions,
}: CommentsFilterBarProps) {
  return (
    <div
      data-testid="comments-filter-bar"
      className="flex flex-wrap items-end gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-snug"
    >
      {/* Status */}
      <FilterSelect
        testId="filter-status"
        label={m.filter.statusLabel}
        value={filter.status ?? ''}
        onChange={(v) => onFilterChange('status', v || undefined)}
        options={[
          { value: '', label: m.filter.allStatus },
          { value: 'pending', label: m.filter.statusPending },
          { value: 'applied', label: m.filter.statusApplied },
          { value: 'not_applicable', label: m.filter.statusNotApplicable },
        ]}
      />

      {/* Priority */}
      <FilterSelect
        testId="filter-priority"
        label={m.filter.priorityLabel}
        value={filter.priority ?? ''}
        onChange={(v) => onFilterChange('priority', v || undefined)}
        options={[
          { value: '', label: m.filter.allPriority },
          { value: 'must', label: m.filter.priorityMust },
          { value: 'should', label: m.filter.priorityShould },
          { value: 'may', label: m.filter.priorityMay },
        ]}
      />

      {/* Target Kind */}
      <FilterSelect
        testId="filter-target-kind"
        label={m.filter.targetKindLabel}
        value={filter.target_kind ?? ''}
        onChange={(v) => onFilterChange('target_kind', v || undefined)}
        options={[
          { value: '', label: m.filter.allTargetKind },
          { value: 'chapter', label: m.filter.targetKindChapter },
          { value: 'outline', label: m.filter.targetKindOutline },
          { value: 'cover', label: m.filter.targetKindCover },
          { value: 'cover_text', label: m.filter.targetKindCoverText },
          { value: 'metadata', label: m.filter.targetKindMetadata },
          { value: 'theme', label: m.filter.targetKindTheme },
        ]}
      />

      {/* Book */}
      <FilterSelect
        testId="filter-book"
        label={m.filter.bookLabel}
        value={filter.book_id ?? ''}
        onChange={(v) => onFilterChange('book_id', v || undefined)}
        options={[
          { value: '', label: m.filter.allBooks },
          ...bookOptions.map((b) => ({ value: b.id, label: b.title })),
        ]}
      />

      {/* Separator */}
      <div className="ml-auto" />

      {/* Group by */}
      <FilterSelect
        testId="filter-group-by"
        label={m.groupBy.label}
        value={groupBy}
        onChange={(v) => onGroupByChange((v || 'book') as GroupByKey)}
        options={[
          { value: 'book', label: m.groupBy.book },
          { value: 'target_kind', label: m.groupBy.target_kind },
          { value: 'priority', label: m.groupBy.priority },
        ]}
      />
    </div>
  );
}

interface FilterSelectProps {
  testId: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}

function FilterSelect({ testId, label, value, onChange, options }: FilterSelectProps) {
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={testId}
        className="text-button-sm text-muted"
      >
        {label}
      </label>
      <select
        id={testId}
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-default border border-border-warm bg-cream-light px-3 py-1.5 text-button-sm text-charcoal focus:outline-none focus:ring-2 focus:ring-ring"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
