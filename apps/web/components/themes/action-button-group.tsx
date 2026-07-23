'use client';

/**
 * S-007 アクションボタン群 (T-03-08).
 *
 * - accept: `acceptThemesAndCreateBatch({ theme_ids: [id] })` = 採用 + 夜間バッチ
 *   計画を自動作成 → `/batches` へ遷移 (一覧のバルクバーと同じ 1 本道)。
 * - reject: `bulkDecideThemes({ theme_ids: [id], decision: 'reject' })`。
 *
 * - pending → accept / reject ボタン enabled
 * - accepted / rejected → 各ボタン disabled + ヒント表示
 * - 成功時は router.refresh() でページ再取得 (ステータスバッジ等が更新される)
 *
 * data-testid: action-button-group / action-accept-button-{id} /
 *              action-reject-button-{id} / action-back-button
 */
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { CommentAffordance } from '@/components/comments/comment-affordance';
import { acceptThemesAndCreateBatch, bulkDecideThemes } from '@/app/actions/themes';
import { messages } from '@/lib/messages';
import type { CommentPriority, CommentStatus } from '@/lib/comment-helpers';
import type { ThemeStatus, ThemeCommentSerialized } from '@/lib/themes-view';

const ma = messages.themes.detail.actions;

function toExistingComment(c: ThemeCommentSerialized) {
  return {
    id: c.id,
    body: c.body,
    priority: c.priority as CommentPriority,
    status: c.status as CommentStatus,
    created_at: c.created_at,
  };
}

interface ActionButtonGroupProps {
  themeId: string;
  status: ThemeStatus;
  bookId?: string | null;
  comments?: ThemeCommentSerialized[];
}

export function ActionButtonGroup({ themeId, status, bookId, comments = [] }: ActionButtonGroupProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [pendingDecision, setPendingDecision] =
    useState<'accept' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const isPending = status === 'pending';
  const acceptDisabled = pending || !isPending;
  const rejectDisabled = pending || !isPending;

  function decide(decision: 'accept' | 'reject') {
    setError(null);
    setInfo(null);
    setPendingDecision(decision);
    startTransition(async () => {
      if (decision === 'accept') {
        // 採用 = 採用 + 夜間バッチ計画を自動作成 → /batches へ遷移。
        const result = await acceptThemesAndCreateBatch({ theme_ids: [themeId] });
        if (!result.ok) {
          setError(result.error.message);
          setPendingDecision(null);
          return;
        }
        setInfo(ma.acceptSuccess);
        setPendingDecision(null);
        router.push('/batches');
        return;
      }
      const result = await bulkDecideThemes({
        theme_ids: [themeId],
        decision: 'reject',
      });
      if (!result.ok) {
        setError(result.error.message);
        setPendingDecision(null);
        return;
      }
      setInfo(ma.rejectSuccess);
      setPendingDecision(null);
      router.refresh();
    });
  }

  return (
    <section
      data-testid="action-button-group"
      className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed"
    >
      <div className="flex items-start justify-between gap-space-snug">
        <h2 className="text-button font-medium text-charcoal">{ma.sectionTitle}</h2>
        {bookId ? (
          <CommentAffordance
            bookId={bookId}
            targetKind="theme"
            targetId={themeId}
            existingComments={comments.map(toExistingComment)}
            onCommentChange={() => router.refresh()}
          />
        ) : (
          <p className="text-button-sm text-muted" data-testid="action-comment-placeholder">
            {ma.commentPlaceholder}
          </p>
        )}
      </div>

      {status === 'accepted' && (
        <p data-testid="action-status-hint" className="text-button-sm text-success">
          {ma.alreadyAccepted}
        </p>
      )}
      {status === 'rejected' && (
        <p data-testid="action-status-hint" className="text-button-sm text-destructive">
          {ma.alreadyRejected}
        </p>
      )}

      {error && (
        <p data-testid="action-error" className="text-button-sm text-destructive">
          {error}
        </p>
      )}
      {info && (
        <p data-testid="action-info" className="text-button-sm text-success">
          {info}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-space-snug">
        <Button
          type="button"
          variant="default"
          disabled={acceptDisabled}
          onClick={() => decide('accept')}
          data-testid={`action-accept-button-${themeId}`}
        >
          {pending && pendingDecision === 'accept' ? ma.accepting : ma.accept}
        </Button>
        <Button
          type="button"
          variant="destructive"
          disabled={rejectDisabled}
          onClick={() => decide('reject')}
          data-testid={`action-reject-button-${themeId}`}
        >
          {pending && pendingDecision === 'reject' ? ma.rejecting : ma.reject}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push('/themes')}
          data-testid="action-back-button"
        >
          {ma.back}
        </Button>
      </div>
    </section>
  );
}
