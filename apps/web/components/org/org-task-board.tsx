'use client';

/**
 * 全社ToDoカンバン。本部フィルタ＋状態カラムでタスクを表示し、
 * 承認 / 完了 / 取消 の人手操作を行う。
 */
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import {
  DIVISIONS,
  DIVISION_LABELS,
  KANBAN_COLUMNS,
  divisionLabel,
  kindLabel,
  orgRoleLabel,
  priorityLabel,
  statusLabel,
  type Division,
} from '@a2p/contracts/org';

import { approveOrgTask, cancelOrgTask, completeOrgTask } from '@/app/actions/org';
import { messages } from '@/lib/messages';
import type { OrgTaskRow } from '@/lib/org-view';

const m = messages.org.board;

const DIVISION_ACCENT: Record<Division, string> = {
  production: 'bg-blue-100 text-blue-800',
  publishing: 'bg-emerald-100 text-emerald-800',
  analytics: 'bg-violet-100 text-violet-800',
  promotion: 'bg-amber-100 text-amber-800',
  sysops: 'bg-slate-200 text-slate-700',
  finance: 'bg-rose-100 text-rose-800',
};

export function OrgTaskBoard({ tasks }: { tasks: OrgTaskRow[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState<Division | 'all'>('all');
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(
    () => (filter === 'all' ? tasks : tasks.filter((t) => t.division === filter)),
    [tasks, filter],
  );

  const columns = useMemo(() => {
    return KANBAN_COLUMNS.map((status) => ({
      status,
      items: filtered.filter((t) => t.status === status),
    })).filter((c) => c.items.length > 0);
  }, [filtered]);

  function act(fn: (i: { task_id: string }) => Promise<{ ok: boolean }>, taskId: string) {
    setError(null);
    start(async () => {
      const res = await fn({ task_id: taskId });
      if (!res.ok) {
        setError(m.actionError);
        return;
      }
      router.refresh();
    });
  }

  if (tasks.length === 0) {
    return (
      <div className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center text-body text-muted">
        {m.empty}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-space-snug" data-testid="org-task-board">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
          {m.filterAll}（{tasks.length}）
        </FilterChip>
        {DIVISIONS.map((d) => {
          const n = tasks.filter((t) => t.division === d).length;
          if (n === 0) return null;
          return (
            <FilterChip key={d} active={filter === d} onClick={() => setFilter(d)}>
              {DIVISION_LABELS[d]}（{n}）
            </FilterChip>
          );
        })}
      </div>

      {error && <p className="text-button-sm text-destructive" role="alert">{error}</p>}

      <div className="flex gap-space-snug overflow-x-auto pb-2">
        {columns.map((col) => (
          <section key={col.status} className="flex w-72 shrink-0 flex-col gap-2">
            <header className="flex items-center justify-between px-1">
              <h2 className="text-button-sm font-medium text-charcoal">{statusLabel(col.status)}</h2>
              <span className="text-caption text-muted">{col.items.length}</span>
            </header>
            <div className="flex flex-col gap-2">
              {col.items.map((t) => (
                <TaskCard key={t.id} task={t} pending={pending} onAct={act} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-caption ${
        active ? 'border-charcoal bg-charcoal text-cream-light' : 'border-border-warm bg-cream-light text-charcoal-82 hover:bg-cream'
      }`}
    >
      {children}
    </button>
  );
}

function TaskCard({
  task,
  pending,
  onAct,
}: {
  task: OrgTaskRow;
  pending: boolean;
  onAct: (fn: (i: { task_id: string }) => Promise<{ ok: boolean }>, id: string) => void;
}) {
  const isHuman = task.status === 'needs_human';
  const isDone = task.status === 'done' || task.status === 'canceled';
  return (
    <article className="flex flex-col gap-1.5 rounded-card border border-border-warm bg-cream-light p-space-snug shadow-l1">
      <div className="flex items-center justify-between gap-2">
        <span className={`rounded px-1.5 py-0.5 text-caption ${DIVISION_ACCENT[task.division as Division] ?? 'bg-slate-100 text-slate-700'}`}>
          {divisionLabel(task.division)}
        </span>
        <span className="text-caption text-muted">{kindLabel(task.kind)}・{priorityLabel(task.priority)}</span>
      </div>

      <h3 className="text-button-sm font-medium text-charcoal">{task.title}</h3>
      <p className="line-clamp-3 text-caption text-charcoal-82">{task.instruction}</p>

      <dl className="flex flex-col gap-0.5 text-caption text-muted">
        {task.bookTitle && (
          <div className="flex gap-1"><dt>{m.book}:</dt><dd className="text-charcoal-82">{task.bookTitle}</dd></div>
        )}
        {task.channel && (
          <div className="flex gap-1"><dt>{m.channel}:</dt><dd className="text-charcoal-82">{task.channel}{task.accountRef ? `（${task.accountRef}）` : ''}</dd></div>
        )}
        <div className="flex gap-2">
          <span>{m.owner}: {orgRoleLabel(task.ownerRole)}</span>
          <span>{m.assignee}: {orgRoleLabel(task.assigneeRole)}</span>
        </div>
        {task.costJpy != null && task.costJpy > 0 && (
          <div className="flex gap-1"><dt>{m.cost}:</dt><dd className="text-charcoal-82">¥{Math.round(task.costJpy).toLocaleString('ja-JP')}</dd></div>
        )}
      </dl>

      {isHuman && (
        <span className="w-fit rounded bg-amber-200 px-1.5 py-0.5 text-caption font-medium text-amber-900">{m.humanBadge}</span>
      )}

      {!isDone && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {task.status === 'proposed' && (
            <ActionBtn disabled={pending} onClick={() => onAct(approveOrgTask, task.id)}>{m.approve}</ActionBtn>
          )}
          <ActionBtn disabled={pending} onClick={() => onAct(completeOrgTask, task.id)}>{m.complete}</ActionBtn>
          <ActionBtn disabled={pending} variant="ghost" onClick={() => onAct(cancelOrgTask, task.id)}>{m.cancel}</ActionBtn>
        </div>
      )}
    </article>
  );
}

function ActionBtn({
  children,
  onClick,
  disabled,
  variant = 'solid',
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'solid' | 'ghost';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-2 py-1 text-caption disabled:opacity-50 ${
        variant === 'solid'
          ? 'bg-charcoal text-cream-light hover:opacity-80'
          : 'border border-border-warm text-charcoal-82 hover:bg-cream'
      }`}
    >
      {children}
    </button>
  );
}
