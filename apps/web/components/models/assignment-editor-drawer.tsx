'use client';

/**
 * AssignmentEditorDrawer (S-019) — モデル割当の編集モーダル.
 *
 * native `<dialog>` を使い shadcn の Drawer 依存を避ける (EditCatalogDrawer と同パターン).
 *
 * - role / genre は表示固定 (props で渡される)
 * - provider セレクトを変更すると model セレクトの選択肢が動的に絞られる
 * - 「変更前後コスト差」は SP-03 で実装する placeholder 表示
 * - 「変更を適用」で `upsertModelAssignment` SA を呼び、成功で router.refresh()
 *
 * 親 (AssignmentMatrix) はマトリクスセルクリックで `open()` を ref 経由で呼ぶ。
 */
import { useEffect, useImperativeHandle, useMemo, useRef, useState, useTransition, forwardRef } from 'react';
import { useRouter } from 'next/navigation';

import { upsertModelAssignment } from '@/app/actions/model-assignments';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { messages } from '@/lib/messages';
import {
  groupCatalogByProvider,
  type CatalogRowSerialized,
  type MatrixGenreSlot,
  type MatrixRole,
  genreSlotToDbValue,
} from '@/lib/model-assignments-view';

export interface AssignmentEditorTarget {
  role: MatrixRole;
  genreSlot: MatrixGenreSlot;
  /** 現在の active 行 (なければ null = 未設定セル)。 */
  currentProvider: string | null;
  currentModel: string | null;
}

export interface AssignmentEditorHandle {
  open(target: AssignmentEditorTarget): void;
}

interface Props {
  catalog: readonly CatalogRowSerialized[];
}

export const AssignmentEditorDrawer = forwardRef<AssignmentEditorHandle, Props>(
  function AssignmentEditorDrawer({ catalog }, ref) {
    const m = messages.modelAssignments;
    const dialogRef = useRef<HTMLDialogElement | null>(null);
    const [pending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [target, setTarget] = useState<AssignmentEditorTarget | null>(null);
    const [provider, setProvider] = useState<string>('');
    const [model, setModel] = useState<string>('');
    const router = useRouter();
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const grouped = useMemo(() => groupCatalogByProvider(catalog), [catalog]);
    const providers = useMemo(() => Array.from(grouped.keys()).sort(), [grouped]);

    const modelsForProvider = useMemo(() => grouped.get(provider) ?? [], [grouped, provider]);

    useImperativeHandle(ref, () => ({
      open(t: AssignmentEditorTarget) {
        if (closeTimerRef.current) {
          clearTimeout(closeTimerRef.current);
          closeTimerRef.current = null;
        }
        setTarget(t);
        setError(null);
        setSuccessMessage(null);
        const initialProvider = t.currentProvider ?? providers[0] ?? '';
        setProvider(initialProvider);
        const initialModel =
          t.currentProvider === initialProvider && t.currentModel
            ? t.currentModel
            : (grouped.get(initialProvider)?.[0]?.model ?? '');
        setModel(initialModel);
        dialogRef.current?.showModal();
      },
    }));

    // unmount 時に保留中の close タイマをクリア
    useEffect(() => {
      return () => {
        if (closeTimerRef.current) {
          clearTimeout(closeTimerRef.current);
          closeTimerRef.current = null;
        }
      };
    }, []);

    // provider が変わったら model を絞り込み先の先頭にリセット (現値が残っているなら維持)
    useEffect(() => {
      if (!provider) return;
      const list = grouped.get(provider) ?? [];
      if (!list.some((r) => r.model === model)) {
        setModel(list[0]?.model ?? '');
      }
    }, [provider, model, grouped]);

    function close() {
      dialogRef.current?.close();
    }

    const isSame =
      target &&
      target.currentProvider === provider &&
      target.currentModel === model;

    const noCatalogForProvider = modelsForProvider.length === 0;

    function onSubmit(e: React.FormEvent<HTMLFormElement>) {
      e.preventDefault();
      setError(null);
      setSuccessMessage(null);
      if (!target) return;
      if (!provider || !model) {
        setError(m.errors.validation);
        return;
      }
      const payload = {
        role: target.role,
        genre: genreSlotToDbValue(target.genreSlot),
        provider,
        model,
      };
      startTransition(async () => {
        const result = await upsertModelAssignment(payload);
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        // F-023: 「次回ジョブから適用」を明示してから close する。
        setSuccessMessage(m.successUpsert);
        router.refresh();
        closeTimerRef.current = setTimeout(() => {
          closeTimerRef.current = null;
          close();
        }, 2500);
      });
    }

    if (!target) {
      // 初回 mount 時は target 未設定。dialog 自体は描画して ref を維持する。
      return (
        <dialog
          ref={dialogRef}
          data-testid="assignment-editor-drawer"
          className="rounded-card border border-border-warm bg-cream-light p-space-loose backdrop:bg-charcoal/40"
        />
      );
    }

    const roleLabel = (m.roles as Record<string, string>)[target.role] ?? target.role;
    const genreLabel = m.genres[target.genreSlot];

    return (
      <dialog
        ref={dialogRef}
        data-testid="assignment-editor-drawer"
        className="rounded-card border border-border-warm bg-cream-light p-space-loose backdrop:bg-charcoal/40"
      >
        <h2 className="text-card-title text-foreground">{m.editor.title}</h2>
        <p className="mt-1 text-body text-charcoal-82">
          {m.editor.heading(roleLabel, genreLabel)}
        </p>

        <form onSubmit={onSubmit} className="mt-space-loose flex w-[28rem] flex-col gap-space-snug">
          <div className="flex flex-col gap-1">
            <Label htmlFor="assignment-editor-provider">{m.editor.provider}</Label>
            <select
              id="assignment-editor-provider"
              data-testid="assignment-editor-provider-select"
              value={provider}
              onChange={(e) => setProvider(e.currentTarget.value)}
              className="h-10 rounded-default border border-border-warm bg-cream-light px-2 text-body text-charcoal"
            >
              {providers.length === 0 && <option value="">—</option>}
              {providers.map((p) => (
                <option key={p} value={p}>
                  {(m.providers as Record<string, string>)[p] ?? p}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="assignment-editor-model">{m.editor.model}</Label>
            <select
              id="assignment-editor-model"
              data-testid="assignment-editor-model-select"
              value={model}
              onChange={(e) => setModel(e.currentTarget.value)}
              className="h-10 rounded-default border border-border-warm bg-cream-light px-2 text-body text-charcoal"
            >
              {modelsForProvider.length === 0 && (
                <option value="">{m.editor.modelPlaceholder}</option>
              )}
              {modelsForProvider.map((r) => (
                <option key={r.id} value={r.model}>
                  {r.model}
                </option>
              ))}
            </select>
          </div>

          <div className="rounded-card border border-border-warm bg-cream p-space-snug">
            <p className="text-button-sm text-charcoal-82">{m.editor.costDiffTitle}</p>
            <p className="mt-1 text-body text-muted">{m.editor.costDiffPlaceholder}</p>
          </div>

          {noCatalogForProvider && (
            <p role="alert" className="text-button-sm text-destructive">
              {m.editor.noCatalogWarning}
            </p>
          )}

          {isSame && (
            <p role="status" className="text-button-sm text-muted">
              {m.editor.sameAsCurrentWarning}
            </p>
          )}

          {error && (
            <p role="alert" className="text-button-sm text-destructive">
              {error}
            </p>
          )}

          {successMessage && (
            <p
              role="status"
              data-testid="assignment-editor-success"
              className="text-button-sm text-charcoal-82"
            >
              {successMessage}
            </p>
          )}

          <div className="mt-space-snug flex justify-end gap-space-snug">
            <Button
              type="button"
              variant="outline"
              onClick={close}
              disabled={pending || successMessage !== null}
            >
              {m.editor.cancel}
            </Button>
            <Button
              type="submit"
              data-testid="assignment-editor-save-button"
              disabled={
                pending ||
                noCatalogForProvider ||
                isSame ||
                !provider ||
                !model ||
                successMessage !== null
              }
            >
              {pending ? m.editor.saving : m.editor.save}
            </Button>
          </div>
        </form>
      </dialog>
    );
  },
);
