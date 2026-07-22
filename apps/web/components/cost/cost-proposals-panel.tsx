'use client';

/**
 * F-062 — コスト改善提案パネル。週次で生成された提案を一覧し、承認(=安全な設定変更を実行)/却下する。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { approveCostProposal, dismissCostProposal } from '@/app/actions/cost-proposals';
import { messages } from '@/lib/messages';
import { cn } from '@/lib/cn';

const m = messages.costDashboard.proposals;

export interface CostProposalSerialized {
  id: string;
  category: string;
  title: string;
  description: string;
  estimated_saving_jpy: number;
  impact_note: string;
  action_kind: string;
  status: string;
  apply_result: string | null;
  created_at: string;
}

export function CostProposalsPanel({ proposals }: { proposals: CostProposalSerialized[] }) {
  const active = proposals.filter((p) => p.status === 'proposed');
  const history = proposals.filter((p) => p.status !== 'proposed');

  return (
    <section className="flex flex-col gap-space-relaxed rounded-card border border-border-warm bg-cream p-space-relaxed" data-testid="cost-proposals">
      <div className="flex flex-col gap-1">
        <h2 className="text-card-title text-charcoal">{m.title}</h2>
        <p className="text-caption text-muted">{m.subtitle}</p>
      </div>

      {active.length === 0 ? (
        <p className="rounded-default border border-border-warm bg-cream-light p-space-snug text-caption text-muted">{m.empty}</p>
      ) : (
        <div className="flex flex-col gap-space-snug">
          {active.map((p) => (
            <ProposalCard key={p.id} p={p} />
          ))}
        </div>
      )}

      {history.length > 0 && (
        <details className="text-caption text-muted">
          <summary className="cursor-pointer">履歴（{history.length}）</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {history.slice(0, 12).map((p) => (
              <li key={p.id} className="flex items-center gap-2">
                <StatusBadge status={p.status} />
                <span className="text-charcoal-82">{p.title}</span>
                {p.apply_result && <span className="text-muted">— {p.apply_result}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  const label =
    status === 'applied' ? m.statusApplied : status === 'dismissed' ? m.statusDismissed : status === 'failed' ? m.statusFailed : status;
  const cls =
    status === 'applied'
      ? 'bg-success-bg text-success'
      : status === 'failed'
        ? 'bg-destructive-bg text-destructive'
        : 'bg-charcoal-04 text-charcoal-82';
  return <span className={cn('rounded-pill px-2 py-0.5 text-caption', cls)}>{label}</span>;
}

function ProposalCard({ p }: { p: CostProposalSerialized }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const executable = p.action_kind === 'switch_model_assignment' || p.action_kind === 'set_app_setting';

  function act(fn: (i: { id: string }) => Promise<{ ok: boolean; data?: unknown; error?: { message: string } }>) {
    setMsg(null);
    start(async () => {
      const res = await fn({ id: p.id });
      if (res.ok) {
        const text = (res.data as { message?: string } | undefined)?.message ?? '';
        setMsg({ ok: true, text });
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error?.message ?? m.error });
      }
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-card border border-border-warm bg-cream-light p-space-relaxed" data-testid={`cost-proposal-${p.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-pill bg-charcoal-04 px-2 py-0.5 text-caption text-charcoal-82">{m.categoryLabel(p.category)}</span>
        <span className={cn('rounded-pill px-2 py-0.5 text-caption', executable ? 'bg-accent-bg text-accent' : 'bg-charcoal-04 text-muted')}>
          {executable ? m.autoExecutable : m.advisoryOnly}
        </span>
        {p.estimated_saving_jpy > 0 && (
          <span className="ml-auto text-button-sm font-medium text-charcoal">
            {m.estimatedSaving} ¥{p.estimated_saving_jpy.toLocaleString('ja-JP')}
            <span className="text-caption text-muted">{m.perMonth}</span>
          </span>
        )}
      </div>

      <h3 className="text-button font-medium text-charcoal">{p.title}</h3>
      {p.description && <p className="whitespace-pre-wrap text-caption text-charcoal-82">{p.description}</p>}
      {p.impact_note && (
        <p className="text-caption text-muted">
          <span className="font-medium">{m.impact}:</span> {p.impact_note}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-space-snug">
        <button
          type="button"
          onClick={() => act(approveCostProposal)}
          disabled={pending}
          data-testid={`cost-proposal-approve-${p.id}`}
          className="inline-flex items-center rounded-card bg-charcoal px-3 py-1.5 text-button-sm text-cream-light hover:opacity-80 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {pending ? m.approving : m.approve}
        </button>
        <button
          type="button"
          onClick={() => act(dismissCostProposal)}
          disabled={pending}
          className="inline-flex items-center rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal-82 hover:bg-charcoal-04 disabled:opacity-50"
        >
          {m.dismiss}
        </button>
        {msg && <span className={cn('text-caption', msg.ok ? 'text-success' : 'text-destructive')}>{msg.text}</span>}
      </div>
    </div>
  );
}
