'use client';

/**
 * docs/06 P4 増分5 — org ロールのモデル最適化 bakeoff 起動コントロール。
 * ロールを選んで検証開始 → 完了後に切替提案が全社ToDoへ起票される（適用は人手）。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FlaskConical } from 'lucide-react';

import { launchOrgModelBakeoff } from '@/app/actions/org';
import { ORG_BAKEOFF_ROLES, orgRoleLabel } from '@a2p/contracts/org';
import { messages } from '@/lib/messages';

const m = messages.org.bakeoff;

export function ModelBakeoffControl() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [role, setRole] = useState<string>(ORG_BAKEOFF_ROLES[0]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setNote(null);
    setError(null);
    start(async () => {
      const res = await launchOrgModelBakeoff({ role });
      if (!res.ok) {
        setError(res.error?.message ?? m.error);
        return;
      }
      setNote(m.queued);
      router.refresh();
    });
  }

  return (
    <section
      className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed"
      data-testid="org-model-bakeoff"
    >
      <h2 className="text-card-title font-medium text-charcoal">{m.title}</h2>
      <p className="text-caption text-muted">{m.hint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-caption text-muted" htmlFor="bakeoff-role">{m.roleLabel}</label>
        <select
          id="bakeoff-role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded-card border border-line bg-cream-light px-3 py-2 text-button-sm text-charcoal"
          data-testid="org-bakeoff-role"
        >
          {ORG_BAKEOFF_ROLES.map((r) => (
            <option key={r} value={r}>{orgRoleLabel(r)}（{r}）</option>
          ))}
        </select>
        <button
          type="button"
          onClick={onClick}
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-card bg-charcoal px-4 py-2 text-button-sm text-cream-light hover:opacity-80 disabled:opacity-50"
          data-testid="org-bakeoff-launch"
        >
          <FlaskConical aria-hidden className="h-4 w-4" />
          {pending ? m.running : m.cta}
        </button>
      </div>
      {note && <span className="text-caption text-success" role="status">{note}</span>}
      {error && <span className="text-caption text-destructive" role="alert">{error}</span>}
    </section>
  );
}
