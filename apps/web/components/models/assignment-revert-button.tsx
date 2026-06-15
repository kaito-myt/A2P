'use client';

/**
 * AssignmentRevertButton — 履歴 (archived) 行を再度 active に戻すボタン.
 *
 * `revertModelAssignment` SA を呼び、成功で router.refresh() し inline で
 * `m.successRevert` を表示 (F-023 受入基準: ユーザーへの明示フィードバック)。
 * 失敗は inline alert。archived 行のみで描画される (page 側で status='archived'
 * に対してのみ render)。
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { revertModelAssignment } from '@/app/actions/model-assignments';
import { Button } from '@/components/ui/button';
import { messages } from '@/lib/messages';

interface Props {
  assignmentId: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'ok'; text: string }
  | { kind: 'err'; text: string };

export function AssignmentRevertButton({ assignmentId }: Props) {
  const m = messages.modelAssignments;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  function onClick() {
    setStatus({ kind: 'idle' });
    startTransition(async () => {
      const result = await revertModelAssignment({ id: assignmentId });
      if (!result.ok) {
        setStatus({ kind: 'err', text: result.error.message });
        return;
      }
      setStatus({ kind: 'ok', text: m.successRevert });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid={`assignment-revert-button-${assignmentId}`}
        onClick={onClick}
        disabled={pending}
      >
        {pending ? m.history.reverting : m.history.revert}
      </Button>
      {status.kind === 'ok' && (
        <p
          role="status"
          data-testid={`assignment-revert-success-${assignmentId}`}
          className="text-button-sm text-charcoal-82"
        >
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
