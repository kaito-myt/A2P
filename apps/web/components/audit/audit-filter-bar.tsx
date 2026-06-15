'use client';

/**
 * S-029 AuditFilterBar (T-09-03, F-029).
 *
 * actor / action / target_kind / period / keyword フィルタ (searchParams 駆動)。
 * JobsFilterBar と同パターン。
 *
 * 仕様根拠: docs/04 S-029 / SP-09 T-09-03
 */

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback, useTransition } from 'react';

import { messages } from '@/lib/messages';

interface AuditFilterBarProps {
  distinctActions: string[];
  distinctTargetKinds: string[];
  currentActor: string;
  currentAction: string;
  currentTargetKind: string;
  currentPeriod: string;
  currentSearch: string;
}

const m = messages.audit.filter;
const actionLabels = messages.audit.actionLabels;
const targetKindLabels = messages.audit.targetKindLabels;

// Phase 1: operator = actor_id NOT NULL, system = actor_id NULL.
// "optimizer" is not a distinct actor in Phase 1 (no literal stored in DB).
const ACTOR_OPTIONS = [
  { value: 'operator', label: m.actorOperator },
  { value: 'system', label: m.actorSystem },
] as const;

export function AuditFilterBar({
  distinctActions,
  distinctTargetKinds,
  currentActor,
  currentAction,
  currentTargetKind,
  currentPeriod,
  currentSearch,
}: AuditFilterBarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const updateParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === '' || value === 'all') {
        params.delete(key);
      } else {
        params.set(key, value);
      }
      params.delete('page');
      startTransition(() => {
        router.push(`${pathname}?${params.toString()}`);
      });
    },
    [router, pathname, searchParams],
  );

  const selectClass =
    'cursor-pointer rounded-card border border-border-warm bg-white px-2 py-1 text-body text-charcoal focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50';

  return (
    <div
      className="flex flex-wrap items-center gap-space-snug rounded-card border border-border-warm bg-cream-light px-space-relaxed py-space-snug"
      data-testid="audit-filter-bar"
    >
      {/* Actor */}
      <label className="flex items-center gap-1.5">
        <span className="whitespace-nowrap text-button-sm text-muted">{m.actorLabel}</span>
        <select
          className={selectClass}
          value={currentActor}
          disabled={isPending}
          onChange={(e) => updateParam('actor', e.target.value)}
          aria-label={m.actorLabel}
        >
          <option value="all">{m.actorAll}</option>
          {ACTOR_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      {/* Action */}
      <label className="flex items-center gap-1.5">
        <span className="whitespace-nowrap text-button-sm text-muted">{m.actionLabel}</span>
        <select
          className={selectClass}
          value={currentAction}
          disabled={isPending}
          onChange={(e) => updateParam('action', e.target.value)}
          aria-label={m.actionLabel}
        >
          <option value="all">{m.actionAll}</option>
          {distinctActions.map((a) => (
            <option key={a} value={a}>
              {actionLabels[a] ?? a}
            </option>
          ))}
        </select>
      </label>

      {/* Target kind */}
      <label className="flex items-center gap-1.5">
        <span className="whitespace-nowrap text-button-sm text-muted">{m.targetKindLabel}</span>
        <select
          className={selectClass}
          value={currentTargetKind}
          disabled={isPending}
          onChange={(e) => updateParam('targetKind', e.target.value)}
          aria-label={m.targetKindLabel}
        >
          <option value="all">{m.targetKindAll}</option>
          {distinctTargetKinds.map((tk) => (
            <option key={tk} value={tk}>
              {targetKindLabels[tk] ?? tk}
            </option>
          ))}
        </select>
      </label>

      {/* Period */}
      <label className="flex items-center gap-1.5">
        <span className="whitespace-nowrap text-button-sm text-muted">{m.periodLabel}</span>
        <select
          className={selectClass}
          value={currentPeriod}
          disabled={isPending}
          onChange={(e) => updateParam('period', e.target.value)}
          aria-label={m.periodLabel}
        >
          {m.periodOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      {/* Keyword search */}
      <label className="flex items-center gap-1.5">
        <span className="sr-only">{m.searchLabel}</span>
        <input
          type="search"
          className="rounded-card border border-border-warm bg-white px-2 py-1 text-body text-charcoal placeholder:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
          placeholder={m.searchPlaceholder}
          value={currentSearch}
          disabled={isPending}
          aria-label={m.searchLabel}
          onChange={(e) => updateParam('q', e.target.value)}
        />
      </label>
    </div>
  );
}
