'use client';

/**
 * ManualRefreshButton (S-020) — `catalog.fetch` ジョブを手動 enqueue する。
 *
 * `refreshModelCatalog` SA を呼んで graphile-worker に enqueue。
 * 成功時は inline メッセージで通知し、`router.refresh()` で RSC 再評価。
 * 失敗時はインライン error 表示。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { refreshModelCatalog } from '@/app/actions/model-catalog';
import { Button } from '@/components/ui/button';
import { messages } from '@/lib/messages';

export function ManualRefreshButton() {
  const m = messages.modelCatalog;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<{ kind: 'idle' } | { kind: 'ok'; text: string } | { kind: 'err'; text: string }>(
    { kind: 'idle' },
  );

  function onClick() {
    setStatus({ kind: 'idle' });
    startTransition(async () => {
      const result = await refreshModelCatalog({ trigger: 'manual' });
      if (result.ok) {
        setStatus({ kind: 'ok', text: m.successRefresh });
        router.refresh();
      } else {
        setStatus({ kind: 'err', text: result.error.message });
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        data-testid="catalog-refresh-button"
        onClick={onClick}
        disabled={pending}
      >
        {pending ? m.actions.refreshing : m.actions.refresh}
      </Button>
      {status.kind === 'ok' && (
        <p role="status" className="text-button-sm text-charcoal-82">
          {status.text}
        </p>
      )}
      {status.kind === 'err' && (
        <p role="alert" className="text-button-sm text-destructive">
          {status.text}
        </p>
      )}
    </div>
  );
}
