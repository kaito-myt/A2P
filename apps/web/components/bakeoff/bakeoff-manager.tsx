'use client';

/**
 * BakeoffManager (F-053) — 比較の実行フォーム + 実行履歴/結果表。
 */
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { startBakeoff } from '@/app/actions/bakeoff';
import { messages } from '@/lib/messages';
import { cn } from '@/lib/cn';
import {
  BAKEOFF_ROLES,
  BAKEOFF_GENRES,
  type BakeoffRunRow,
  type BakeoffResultRow,
  type CandidateModel,
} from '@/lib/bakeoff-view';

const m = messages.bakeoff;

function keyOf(c: CandidateModel) {
  return `${c.provider}/${c.model}`;
}

export function BakeoffManager({
  candidates,
  runs,
}: {
  candidates: CandidateModel[];
  runs: BakeoffRunRow[];
}) {
  return (
    <div className="flex flex-col gap-space-loose">
      <StartForm candidates={candidates} />
      <RunList runs={runs} />
    </div>
  );
}

function StartForm({ candidates }: { candidates: CandidateModel[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [role, setRole] = useState<string>('writer');
  const [genre, setGenre] = useState<string>('');
  const [label, setLabel] = useState('');
  const [user, setUser] = useState('');
  const [systemExtra, setSystemExtra] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [info, setInfo] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const g: Record<string, CandidateModel[]> = {};
    for (const c of candidates) (g[c.provider] ??= []).push(c);
    return g;
  }, [candidates]);

  function toggle(c: CandidateModel) {
    const k = keyOf(c);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function submit() {
    setInfo(null);
    const chosen = candidates.filter((c) => selected.has(keyOf(c)));
    if (chosen.length < 2) {
      setInfo(m.form.needTwo);
      return;
    }
    start(async () => {
      const res = await startBakeoff({
        role,
        genre: genre || undefined,
        input_label: label || `${role} 比較`,
        user,
        ...(systemExtra ? { system_extra: systemExtra } : {}),
        candidates: chosen,
      });
      if (!res.ok) {
        setInfo(res.error?.message ?? m.errors.start);
        return;
      }
      setInfo(m.form.started);
      setUser('');
      setLabel('');
      setSelected(new Set());
      router.refresh();
    });
  }

  const inputCls =
    'w-full rounded-default border border-border-warm bg-cream-light px-3 py-2 text-button-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <section className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed">
      <h2 className="text-card-title font-medium text-charcoal">{m.form.title}</h2>

      <div className="grid grid-cols-1 gap-space-snug md:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-button-sm text-charcoal-82">{m.form.role}</span>
          <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>
            {BAKEOFF_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-button-sm text-charcoal-82">{m.form.genre}</span>
          <select className={inputCls} value={genre} onChange={(e) => setGenre(e.target.value)}>
            <option value="">{m.form.genreAny}</option>
            {BAKEOFF_GENRES.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-button-sm text-charcoal-82">{m.form.label}</span>
        <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={m.form.labelPlaceholder} />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-button-sm text-charcoal-82">{m.form.user}</span>
        <textarea
          className={cn(inputCls, 'min-h-28 font-mono')}
          value={user}
          onChange={(e) => setUser(e.target.value)}
          placeholder={m.form.userPlaceholder}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-button-sm text-charcoal-82">{m.form.systemExtra}</span>
        <textarea className={cn(inputCls, 'min-h-16')} value={systemExtra} onChange={(e) => setSystemExtra(e.target.value)} />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-button-sm text-charcoal-82">{m.form.candidates}</span>
        <div className="flex flex-col gap-2">
          {Object.entries(grouped).map(([provider, models]) => (
            <div key={provider} className="flex flex-col gap-1">
              <span className="text-caption font-medium uppercase tracking-wide text-charcoal-40">{provider}</span>
              <div className="flex flex-wrap gap-1.5">
                {models.map((c) => {
                  const k = keyOf(c);
                  const on = selected.has(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => toggle(c)}
                      className={cn(
                        'rounded-pill border px-2.5 py-1 text-caption transition-colors',
                        on
                          ? 'border-accent bg-accent-bg text-accent'
                          : 'border-border-warm bg-cream text-charcoal-82 hover:bg-charcoal-04',
                      )}
                    >
                      {c.model}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-space-snug">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="inline-flex items-center rounded-card bg-charcoal px-3 py-1.5 text-button-sm text-cream-light shadow-l2-inset hover:opacity-80 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {pending ? m.form.running : m.form.submit}
        </button>
        {info && <span className="text-caption text-accent">{info}</span>}
      </div>
    </section>
  );
}

function statusClass(status: string): string {
  switch (status) {
    case 'done':
      return 'bg-success-bg text-success';
    case 'failed':
      return 'bg-destructive-bg text-destructive';
    case 'running':
      return 'bg-accent-bg text-accent';
    default:
      return 'bg-charcoal-04 text-charcoal-82';
  }
}

function RunList({ runs }: { runs: BakeoffRunRow[] }) {
  return (
    <section className="flex flex-col gap-space-snug">
      <h2 className="text-card-title font-medium text-charcoal">{m.list.title}</h2>
      {runs.length === 0 ? (
        <div className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center">
          <p className="text-body text-muted">{m.list.empty}</p>
        </div>
      ) : (
        runs.map((run) => <RunCard key={run.id} run={run} />)
      )}
    </section>
  );
}

function RunCard({ run }: { run: BakeoffRunRow }) {
  const [open, setOpen] = useState(false);
  const yen = (n: number | null) => (n == null ? '—' : `¥${n.toFixed(2)}`);

  return (
    <div className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex flex-wrap items-center justify-between gap-2 text-left">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-card-title font-medium text-charcoal">{run.inputLabel}</span>
          <span className="text-caption text-muted">
            {run.role}
            {run.genre ? ` / ${run.genre}` : ''} · {run.createdAt ? new Date(run.createdAt).toLocaleString('ja-JP') : ''}
          </span>
        </div>
        <span className={cn('rounded-pill px-2 py-0.5 text-caption', statusClass(run.status))}>{run.status}</span>
      </button>

      {open && run.results.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-button-sm">
            <thead>
              <tr className="border-b border-border-warm text-left text-caption text-muted">
                <th className="py-2 pr-3 font-medium">{m.result.rank}</th>
                <th className="py-2 pr-3 font-medium">{m.result.model}</th>
                <th className="py-2 pr-3 font-medium">{m.result.score}</th>
                <th className="py-2 pr-3 font-medium">{m.result.cost}</th>
                <th className="py-2 pr-3 font-medium">{m.result.latency}</th>
                <th className="py-2 font-medium">{m.result.rationale}</th>
              </tr>
            </thead>
            <tbody>
              {run.results.map((r) => (
                <ResultRow key={r.id} r={r} yen={yen} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ResultRow({ r, yen }: { r: BakeoffResultRow; yen: (n: number | null) => string }) {
  const [showOut, setShowOut] = useState(false);
  return (
    <>
      <tr className="border-b border-border-warm/70 align-top">
        <td className="py-2 pr-3">
          {r.rank === 1 ? (
            <span className="rounded-pill bg-success-bg px-2 py-0.5 text-caption text-success">★ {m.result.winner}</span>
          ) : (
            <span className="text-charcoal-82">{r.rank ?? '—'}</span>
          )}
        </td>
        <td className="py-2 pr-3">
          <button type="button" onClick={() => setShowOut((s) => !s)} className="text-left text-charcoal underline underline-offset-2">
            {r.model}
          </button>
          <div className="text-caption text-muted">{r.provider}</div>
          {r.error && <div className="text-caption text-destructive">{m.result.failed}: {r.error}</div>}
        </td>
        <td className="py-2 pr-3 font-medium text-charcoal">{r.qualityScore ?? '—'}</td>
        <td className="py-2 pr-3 text-charcoal-82">{yen(r.costJpy)}</td>
        <td className="py-2 pr-3 text-charcoal-82">{r.latencyMs != null ? `${(r.latencyMs / 1000).toFixed(1)}s` : '—'}</td>
        <td className="py-2 text-charcoal-82">{r.rationale ?? '—'}</td>
      </tr>
      {showOut && r.outputText && (
        <tr>
          <td colSpan={6} className="pb-3">
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-card border border-border-warm bg-cream p-space-snug text-caption text-charcoal">
              {r.outputText}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
