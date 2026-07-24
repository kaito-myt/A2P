'use client';

/**
 * 低品質本 間引きレビュー（クライアント）。候補を選択して「取り下げ承認」または「残す」。
 * 承認は KDP からの取り下げ(出版停止+アーカイブ)ジョブを投入する破壊的操作なので確認を挟む。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { approveCull, rejectCull, type CullCandidateView } from '@/app/actions/book-cull';

export function CullReviewClient({ candidates }: { candidates: CullCandidateView[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const allSelected = candidates.length > 0 && selected.size === candidates.length;
  function toggle(id: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(candidates.map((c) => c.book_id)));
  }

  function doApprove() {
    if (selected.size === 0) return;
    if (!window.confirm(`${selected.size} 冊を KDP から取り下げます（出版停止＋アーカイブ）。よろしいですか？この操作は Amazon の公開商品に対して実行されます。`)) return;
    setErr(null); setMsg(null);
    startTransition(async () => {
      const res = await approveCull({ book_ids: [...selected] });
      if (!res.ok) { setErr(res.error.message); return; }
      setMsg(`${res.data.approved} 冊の取り下げジョブを投入しました（数分で反映）。`);
      setSelected(new Set());
      router.refresh();
    });
  }
  function doReject() {
    if (selected.size === 0) return;
    setErr(null); setMsg(null);
    startTransition(async () => {
      const res = await rejectCull({ book_ids: [...selected] });
      if (!res.ok) { setErr(res.error.message); return; }
      setMsg(`${res.data.rejected} 冊を「残す」にしました。`);
      setSelected(new Set());
      router.refresh();
    });
  }

  if (candidates.length === 0) {
    return <p className="text-body text-muted" data-testid="cull-empty">現在、取り下げ候補はありません。</p>;
  }

  return (
    <div className="flex flex-col gap-space-snug" data-testid="cull-review">
      <div className="flex flex-wrap items-center gap-space-snug">
        <button type="button" onClick={toggleAll} className="rounded-default border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04">
          {allSelected ? '全選択解除' : 'すべて選択'}
        </button>
        <span className="text-caption text-muted">{selected.size} / {candidates.length} 選択中</span>
        <div className="ml-auto flex gap-space-snug">
          <button type="button" onClick={doReject} disabled={pending || selected.size === 0}
            className="rounded-default border border-border-warm bg-cream px-4 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04 disabled:opacity-50">
            残す
          </button>
          <button type="button" onClick={doApprove} disabled={pending || selected.size === 0}
            className="rounded-default bg-destructive px-4 py-1.5 text-button-sm text-white hover:opacity-90 disabled:opacity-50">
            {pending ? '処理中…' : '取り下げ承認'}
          </button>
        </div>
      </div>
      {err && <p className="text-button-sm text-destructive">{err}</p>}
      {msg && <p className="text-button-sm text-success">{msg}</p>}

      <div className="overflow-x-auto rounded-card border border-border-warm">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b border-border-warm bg-cream-light text-left">
              <th className="px-space-relaxed py-space-snug"></th>
              <th className="px-space-relaxed py-space-snug font-medium text-charcoal">タイトル</th>
              <th className="px-space-relaxed py-space-snug font-medium text-charcoal">ASIN</th>
              <th className="px-space-relaxed py-space-snug font-medium text-charcoal">低迷の根拠</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => (
              <tr key={c.book_id} className="border-b border-border-warm last:border-0 hover:bg-cream-light">
                <td className="px-space-relaxed py-space-snug">
                  <input type="checkbox" checked={selected.has(c.book_id)} onChange={() => toggle(c.book_id)} aria-label={`${c.title} を選択`} />
                </td>
                <td className="max-w-md px-space-relaxed py-space-snug">
                  <span className="line-clamp-2 text-foreground">{c.title}</span>
                </td>
                <td className="whitespace-nowrap px-space-relaxed py-space-snug font-mono text-caption text-muted">{c.asin ?? '—'}</td>
                <td className="px-space-relaxed py-space-snug text-caption text-charcoal-82">{c.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
