'use client';

/**
 * EditCatalogDrawer (S-020) — モデル単価カタログの手動編集モーダル。
 *
 * native `<dialog>` を使い、shadcn/ui の Drawer 等の追加依存を避ける
 * (ArchiveButton と同パターン)。
 *
 * 入力は USD / 100 万 tok 単位で受け、`editCatalogEntry` SA に転送。
 */
import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { editCatalogEntry } from '@/app/actions/model-catalog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { messages } from '@/lib/messages';

export interface EditCatalogRow {
  id: string;
  provider: string;
  model: string;
  input_price_per_mtok_usd: string;
  output_price_per_mtok_usd: string;
  image_price_per_image_usd: string | null;
}

interface EditCatalogDrawerProps {
  row: EditCatalogRow;
}

export function EditCatalogDrawer({ row }: EditCatalogDrawerProps) {
  const m = messages.modelCatalog;
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [inputPrice, setInputPrice] = useState(row.input_price_per_mtok_usd);
  const [outputPrice, setOutputPrice] = useState(row.output_price_per_mtok_usd);
  const [imagePrice, setImagePrice] = useState(row.image_price_per_image_usd ?? '');
  const router = useRouter();

  // 開閉時に row 値で reset (別行のデータが残らないように)
  useEffect(() => {
    setInputPrice(row.input_price_per_mtok_usd);
    setOutputPrice(row.output_price_per_mtok_usd);
    setImagePrice(row.image_price_per_image_usd ?? '');
    setError(null);
  }, [row.id, row.input_price_per_mtok_usd, row.output_price_per_mtok_usd, row.image_price_per_image_usd]);

  function open() {
    setError(null);
    dialogRef.current?.showModal();
  }

  function close() {
    dialogRef.current?.close();
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const payload: Record<string, unknown> = {
      provider: row.provider,
      model: row.model,
    };
    const inN = Number(inputPrice);
    const outN = Number(outputPrice);
    const imgN = imagePrice === '' ? undefined : Number(imagePrice);
    if (!Number.isFinite(inN) || !Number.isFinite(outN) || (imgN !== undefined && !Number.isFinite(imgN))) {
      setError(m.errors.validation);
      return;
    }
    payload.input_price_per_mtok_usd = inN;
    payload.output_price_per_mtok_usd = outN;
    if (imgN !== undefined) payload.image_price_per_image_usd = imgN;

    startTransition(async () => {
      const result = await editCatalogEntry(payload);
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      close();
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid={`catalog-edit-button-${row.id}`}
        onClick={open}
      >
        {m.actions.edit}
      </Button>

      <dialog
        ref={dialogRef}
        className="rounded-card border border-border-warm bg-cream-light p-space-loose backdrop:bg-charcoal/40"
      >
        <h2 className="text-card-title text-foreground">{m.edit.title}</h2>
        <form onSubmit={onSubmit} className="mt-space-loose flex flex-col gap-space-snug">
          <div className="grid grid-cols-2 gap-space-snug">
            <div>
              <Label>{m.edit.provider}</Label>
              <p className="text-body text-charcoal-82">{row.provider}</p>
            </div>
            <div>
              <Label>{m.edit.model}</Label>
              <p className="text-body text-charcoal-82">{row.model}</p>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={`input-${row.id}`}>{m.edit.inputPrice}</Label>
            <Input
              id={`input-${row.id}`}
              type="number"
              step="0.000001"
              min="0"
              value={inputPrice}
              onChange={(e) => setInputPrice(e.currentTarget.value)}
              required
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={`output-${row.id}`}>{m.edit.outputPrice}</Label>
            <Input
              id={`output-${row.id}`}
              type="number"
              step="0.000001"
              min="0"
              value={outputPrice}
              onChange={(e) => setOutputPrice(e.currentTarget.value)}
              required
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={`image-${row.id}`}>{m.edit.imagePrice}</Label>
            <Input
              id={`image-${row.id}`}
              type="number"
              step="0.000001"
              min="0"
              value={imagePrice}
              onChange={(e) => setImagePrice(e.currentTarget.value)}
            />
          </div>

          <p className="text-button-sm text-muted">{m.edit.note}</p>

          {error && (
            <p role="alert" className="text-button-sm text-destructive">
              {error}
            </p>
          )}

          <div className="mt-space-snug flex justify-end gap-space-snug">
            <Button type="button" variant="outline" onClick={close} disabled={pending}>
              {m.actions.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? m.actions.saving : m.actions.save}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
