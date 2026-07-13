'use client';

/**
 * docs/06 P4 増分2 — 販促アカウント台帳の接続フォーム（pending 行を connected へ）。
 * アカウント作成・サインアップは運営者が各SNSで行い、ここでハンドル＋トークンを接続する。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { connectPromotionAccount, archivePromotionAccount } from '@/app/actions/promotion-accounts';
import { messages } from '@/lib/messages';

const m = messages.org.accounts;

export function AccountConnectForm({ accountId, channel }: { accountId: string; channel: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [handle, setHandle] = useState('');
  const [token, setToken] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onConnect() {
    setNote(null);
    setError(null);
    start(async () => {
      const res = await connectPromotionAccount({ account_id: accountId, handle, token });
      if (!res.ok) {
        setError(res.error?.message ?? m.error);
        return;
      }
      setNote(m.connectedMsg);
      setToken('');
      router.refresh();
    });
  }

  function onArchive() {
    setError(null);
    start(async () => {
      const res = await archivePromotionAccount({ account_id: accountId });
      if (!res.ok) {
        setError(res.error?.message ?? m.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-caption text-muted">{m.connectHint}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder={m.handlePlaceholder}
          className="rounded-card border border-line bg-cream-light px-3 py-2 text-button-sm text-charcoal"
          data-testid={`acct-handle-${accountId}`}
        />
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={m.tokenPlaceholder}
          className="rounded-card border border-line bg-cream-light px-3 py-2 text-button-sm text-charcoal"
          data-testid={`acct-token-${accountId}`}
          autoComplete="off"
        />
        <button
          type="button"
          onClick={onConnect}
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-card bg-charcoal px-4 py-2 text-button-sm text-cream-light hover:opacity-80 disabled:opacity-50"
          data-testid={`acct-connect-${accountId}`}
        >
          {pending ? m.connecting : m.connectCta}
        </button>
        <button
          type="button"
          onClick={onArchive}
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-card border border-line px-3 py-2 text-button-sm text-muted hover:opacity-80 disabled:opacity-50"
          data-testid={`acct-archive-${accountId}`}
        >
          {m.archiveCta}
        </button>
      </div>
      {channel === 'blog' && <span className="text-caption text-muted">blog は所有チャンネルのためトークン不要です。</span>}
      {note && <span className="text-caption text-success" role="status">{note}</span>}
      {error && <span className="text-caption text-destructive" role="alert">{error}</span>}
    </div>
  );
}
