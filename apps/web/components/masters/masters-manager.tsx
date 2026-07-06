'use client';

/**
 * MastersManager — 著者名 / レーベル名マスタの管理 UI。
 *
 * 追加フォーム + 一覧 (有効 / アーカイブ) + 各行のインライン編集 / アーカイブ切替。
 * 著者名は カタカナ・ローマ字・メモ を持ち、レーベル名は メモ のみ。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import {
  createAuthorName,
  updateAuthorName,
  setAuthorNameArchived,
  createLabelName,
  updateLabelName,
  setLabelNameArchived,
} from '@/app/actions/masters';
import { messages } from '@/lib/messages';

const m = messages.masters;

export interface AuthorRow {
  id: string;
  name: string;
  name_kana: string | null;
  name_romaji: string | null;
  note: string | null;
  status: string;
}
export interface LabelRow {
  id: string;
  name: string;
  note: string | null;
  status: string;
}

export function MastersManager({
  authors,
  labels,
}: {
  authors: AuthorRow[];
  labels: LabelRow[];
}) {
  return (
    <div className="flex flex-col gap-space-loose" data-testid="masters-manager">
      <AuthorSection authors={authors} />
      <LabelSection labels={labels} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------

const inputCls =
  'w-full rounded-card border border-border-warm bg-cream-light px-3 py-1.5 text-body text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const btnPrimary =
  'inline-flex items-center rounded-card bg-charcoal px-3 py-1.5 text-button-sm text-cream-light shadow-l2-inset hover:opacity-80 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';
const btnGhost =
  'inline-flex items-center rounded-card border border-border-warm bg-cream px-3 py-1.5 text-button-sm text-charcoal hover:bg-charcoal-04 disabled:opacity-50';

function SectionShell({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed">
      <h2 className="text-card-title font-medium text-charcoal">{heading}</h2>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 著者名
// ---------------------------------------------------------------------------

function AuthorSection({ authors }: { authors: AuthorRow[] }) {
  const active = authors.filter((a) => a.status !== 'archived');
  const archived = authors.filter((a) => a.status === 'archived');
  const [showArchived, setShowArchived] = useState(false);

  return (
    <SectionShell heading={m.authorHeading}>
      <AuthorForm mode="create" />
      <ul className="flex flex-col divide-y divide-border-warm" data-testid="author-list">
        {active.length === 0 ? (
          <li className="py-2 text-button-sm text-muted">{m.empty}</li>
        ) : (
          active.map((a) => <AuthorItem key={a.id} row={a} />)
        )}
      </ul>
      {archived.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="self-start text-button-sm text-muted underline underline-offset-4 hover:no-underline"
          >
            {m.archivedTab} ({archived.length})
          </button>
          {showArchived && (
            <ul className="flex flex-col divide-y divide-border-warm opacity-70">
              {archived.map((a) => (
                <AuthorItem key={a.id} row={a} />
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionShell>
  );
}

function AuthorForm({
  mode,
  row,
  onDone,
}: {
  mode: 'create' | 'edit';
  row?: AuthorRow;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState(row?.name ?? '');
  const [kana, setKana] = useState(row?.name_kana ?? '');
  const [romaji, setRomaji] = useState(row?.name_romaji ?? '');
  const [note, setNote] = useState(row?.note ?? '');
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    setErr(null);
    if (!name.trim()) {
      setErr(m.errors.validation);
      return;
    }
    start(async () => {
      const payload = {
        name: name.trim(),
        name_kana: kana.trim() || undefined,
        name_romaji: romaji.trim() || undefined,
        note: note.trim() || undefined,
      };
      const res =
        mode === 'create'
          ? await createAuthorName(payload)
          : await updateAuthorName({ ...payload, id: row!.id });
      if (!res.ok) {
        setErr(res.error?.message ?? m.errors.unknown);
        return;
      }
      if (mode === 'create') {
        setName('');
        setKana('');
        setRomaji('');
        setNote('');
      }
      onDone?.();
      router.refresh();
    });
  }

  return (
    <div className="grid grid-cols-1 gap-2 rounded-card bg-cream p-space-snug sm:grid-cols-2">
      <input className={inputCls} placeholder={m.placeholders.authorName} value={name} onChange={(e) => setName(e.target.value)} aria-label={m.fields.name} />
      <input className={inputCls} placeholder={m.fields.nameKana} value={kana} onChange={(e) => setKana(e.target.value)} aria-label={m.fields.nameKana} />
      <input className={inputCls} placeholder={m.fields.nameRomaji} value={romaji} onChange={(e) => setRomaji(e.target.value)} aria-label={m.fields.nameRomaji} />
      <input className={inputCls} placeholder={m.placeholders.note} value={note} onChange={(e) => setNote(e.target.value)} aria-label={m.fields.note} />
      <div className="flex items-center gap-2 sm:col-span-2">
        <button type="button" className={btnPrimary} onClick={submit} disabled={pending}>
          {mode === 'create' ? m.addAuthor : m.save}
        </button>
        {mode === 'edit' && (
          <button type="button" className={btnGhost} onClick={onDone} disabled={pending}>
            {m.cancel}
          </button>
        )}
        {err && <span className="text-button-sm text-destructive">{err}</span>}
      </div>
    </div>
  );
}

function AuthorItem({ row }: { row: AuthorRow }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const archived = row.status === 'archived';

  function toggleArchive() {
    start(async () => {
      await setAuthorNameArchived({ id: row.id, archived: !archived });
      router.refresh();
    });
  }

  if (editing) {
    return (
      <li className="py-2">
        <AuthorForm mode="edit" row={row} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`author-item-${row.id}`}>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-body font-medium text-charcoal">{row.name}</span>
        <span className="text-caption text-muted">
          {[row.name_kana, row.name_romaji, row.note].filter(Boolean).join(' / ') || '—'}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className={btnGhost} onClick={() => setEditing(true)} disabled={pending}>
          {m.edit}
        </button>
        <button type="button" className={btnGhost} onClick={toggleArchive} disabled={pending}>
          {archived ? m.unarchive : m.archive}
        </button>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// レーベル名
// ---------------------------------------------------------------------------

function LabelSection({ labels }: { labels: LabelRow[] }) {
  const active = labels.filter((l) => l.status !== 'archived');
  const archived = labels.filter((l) => l.status === 'archived');
  const [showArchived, setShowArchived] = useState(false);

  return (
    <SectionShell heading={m.labelHeading}>
      <LabelForm mode="create" />
      <ul className="flex flex-col divide-y divide-border-warm" data-testid="label-list">
        {active.length === 0 ? (
          <li className="py-2 text-button-sm text-muted">{m.empty}</li>
        ) : (
          active.map((l) => <LabelItem key={l.id} row={l} />)
        )}
      </ul>
      {archived.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="self-start text-button-sm text-muted underline underline-offset-4 hover:no-underline"
          >
            {m.archivedTab} ({archived.length})
          </button>
          {showArchived && (
            <ul className="flex flex-col divide-y divide-border-warm opacity-70">
              {archived.map((l) => (
                <LabelItem key={l.id} row={l} />
              ))}
            </ul>
          )}
        </div>
      )}
    </SectionShell>
  );
}

function LabelForm({
  mode,
  row,
  onDone,
}: {
  mode: 'create' | 'edit';
  row?: LabelRow;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState(row?.name ?? '');
  const [note, setNote] = useState(row?.note ?? '');
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    setErr(null);
    if (!name.trim()) {
      setErr(m.errors.validation);
      return;
    }
    start(async () => {
      const payload = { name: name.trim(), note: note.trim() || undefined };
      const res =
        mode === 'create'
          ? await createLabelName(payload)
          : await updateLabelName({ ...payload, id: row!.id });
      if (!res.ok) {
        setErr(res.error?.message ?? m.errors.unknown);
        return;
      }
      if (mode === 'create') {
        setName('');
        setNote('');
      }
      onDone?.();
      router.refresh();
    });
  }

  return (
    <div className="grid grid-cols-1 gap-2 rounded-card bg-cream p-space-snug sm:grid-cols-2">
      <input className={inputCls} placeholder={m.placeholders.labelName} value={name} onChange={(e) => setName(e.target.value)} aria-label={m.fields.name} />
      <input className={inputCls} placeholder={m.placeholders.note} value={note} onChange={(e) => setNote(e.target.value)} aria-label={m.fields.note} />
      <div className="flex items-center gap-2 sm:col-span-2">
        <button type="button" className={btnPrimary} onClick={submit} disabled={pending}>
          {mode === 'create' ? m.addLabel : m.save}
        </button>
        {mode === 'edit' && (
          <button type="button" className={btnGhost} onClick={onDone} disabled={pending}>
            {m.cancel}
          </button>
        )}
        {err && <span className="text-button-sm text-destructive">{err}</span>}
      </div>
    </div>
  );
}

function LabelItem({ row }: { row: LabelRow }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const archived = row.status === 'archived';

  function toggleArchive() {
    start(async () => {
      await setLabelNameArchived({ id: row.id, archived: !archived });
      router.refresh();
    });
  }

  if (editing) {
    return (
      <li className="py-2">
        <LabelForm mode="edit" row={row} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`label-item-${row.id}`}>
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-body font-medium text-charcoal">{row.name}</span>
        <span className="text-caption text-muted">{row.note || '—'}</span>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className={btnGhost} onClick={() => setEditing(true)} disabled={pending}>
          {m.edit}
        </button>
        <button type="button" className={btnGhost} onClick={toggleArchive} disabled={pending}>
          {archived ? m.unarchive : m.archive}
        </button>
      </div>
    </li>
  );
}
