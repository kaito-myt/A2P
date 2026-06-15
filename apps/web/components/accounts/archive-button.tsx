'use client';

/**
 * ArchiveButton (S-003 行アクション)。
 *
 * `[ ⋯ ]` メニュー → 「アーカイブ」を選ぶと native `<dialog>` で確認を出し、
 * Server Action `archiveAccount` を呼ぶ。
 */
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { archiveAccount } from '@/app/actions/accounts';
import { Button } from '@/components/ui/button';
import { messages } from '@/lib/messages';

interface ArchiveButtonProps {
  accountId: string;
  penName: string;
}

export function ArchiveButton({ accountId, penName }: ArchiveButtonProps) {
  const m = messages.accounts.table;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function openDialog() {
    setMenuOpen(false);
    setError(null);
    dialogRef.current?.showModal();
  }

  function closeDialog() {
    dialogRef.current?.close();
  }

  function confirm() {
    startTransition(async () => {
      const result = await archiveAccount(accountId);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      closeDialog();
      router.refresh();
    });
  }

  return (
    <div className="relative inline-block">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={m.moreMenu}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
        onBlur={(e) => {
          // メニュー外クリックでクローズ
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) {
            setMenuOpen(false);
          }
        }}
      >
        ⋯
      </Button>
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 min-w-[10rem] rounded-default border border-border-warm bg-cream-light py-1 shadow-l3-focus"
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full px-3 py-1.5 text-left text-button-sm text-destructive hover:bg-charcoal-04"
            onClick={openDialog}
          >
            {m.archive}
          </button>
        </div>
      )}

      <dialog
        ref={dialogRef}
        className="rounded-card border border-border-warm bg-cream-light p-space-loose backdrop:bg-charcoal/40"
      >
        <h2 className="text-card-title text-foreground">{m.archiveConfirmTitle}</h2>
        <p className="mt-space-snug max-w-md text-body text-muted">
          {m.archiveConfirmBody}
        </p>
        <p className="mt-space-snug text-button-sm text-charcoal-83">
          対象: <strong>{penName}</strong>
        </p>
        {error && <p className="mt-space-snug text-button-sm text-destructive">{error}</p>}
        <div className="mt-space-loose flex justify-end gap-space-snug">
          <Button type="button" variant="outline" onClick={closeDialog} disabled={pending}>
            {m.archiveConfirmNo}
          </Button>
          <Button type="button" variant="destructive" onClick={confirm} disabled={pending}>
            {m.archiveConfirmYes}
          </Button>
        </div>
      </dialog>
    </div>
  );
}
