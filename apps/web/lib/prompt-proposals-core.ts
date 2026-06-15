/**
 * decideProposal / rollbackAutoApproved のコアロジック (T-11-04)
 *
 * SA ラッパ (app/actions/prompt-proposals.ts) から呼ばれる業務ロジック。
 * 依存は DI で受け取り Vitest でユニットテスト可能にする。
 *
 * approve/edit_and_approve/rollback の全 DB 操作（旧 active archived 化・
 * 新版 INSERT/復元・proposal 更新・audit_log INSERT）は runTransaction に
 * 包まれた 1 トランザクションで実行する。model-assignments-core.ts と同パターン。
 *
 * 設計根拠: docs/05 §4.3.12
 */
import {
  isA2PError,
  fail,
  ok,
  type ActionResult,
} from '@a2p/contracts';
import { Prisma } from '@a2p/db';

import {
  DecideProposalInputSchema,
  RollbackAutoApprovedInputSchema,
} from '@a2p/contracts/api/prompt-proposals';
import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// Row 型 (DI 境界)
// ---------------------------------------------------------------------------

export interface PromptProposalRow {
  id: string;
  source_prompt_id: string;
  role: string;
  genre: string | null;
  proposed_body: string;
  status: string;
  rollback_until: Date | null;
}

export interface PromptRow {
  id: string;
  role: string;
  genre: string | null;
  version: number;
  status: string;
}

// ---------------------------------------------------------------------------
// DI repos
// ---------------------------------------------------------------------------

export interface PromptProposalRepo {
  findById(id: string): Promise<PromptProposalRow | null>;
  update(args: {
    where: { id: string };
    data: Record<string, unknown>;
  }): Promise<PromptProposalRow>;
}

export interface PromptRepo {
  findActiveByRoleGenre(args: { role: string; genre: string | null }): Promise<PromptRow | null>;
  findPreviousVersion(args: {
    role: string;
    genre: string | null;
    currentVersion: number;
  }): Promise<PromptRow | null>;
  update(args: {
    where: { id: string };
    data: Record<string, unknown>;
  }): Promise<PromptRow>;
  create(args: { data: Record<string, unknown> }): Promise<PromptRow>;
}

export interface AuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

/**
 * トランザクション境界。SA ラッパは `prisma.$transaction(async (tx) => fn({
 * proposalRepo: ..., promptRepo: ..., auditLogRepo: tx.auditLog }))` で
 * tx クライアントを注入する。テストでは即時実行（コールバックをそのまま呼ぶ）でよい。
 */
export type RunTransactionFn = <T>(
  fn: (txRepos: {
    proposalRepo: PromptProposalRepo;
    promptRepo: PromptRepo;
    auditLogRepo: AuditLogRepo;
  }) => Promise<T>,
) => Promise<T>;

export interface DecideProposalDeps {
  proposalRepo: PromptProposalRepo;
  promptRepo: PromptRepo;
  auditLogRepo: AuditLogRepo;
  session: AuthenticatedSession;
  runTransaction: RunTransactionFn;
  now?: Date;
}

export type RollbackAutoApprovedDeps = DecideProposalDeps;

// ---------------------------------------------------------------------------
// decideProposalCore
// ---------------------------------------------------------------------------

export async function decideProposalCore(
  input: unknown,
  deps: DecideProposalDeps,
): Promise<ActionResult<{ new_prompt_id?: string }>> {
  const parsed = DecideProposalInputSchema.safeParse(input);
  if (!parsed.success) {
    return fail('validation', messages.promptProposals.errors.validation, parsed.error.flatten());
  }

  const data = parsed.data;

  // edit_and_approve requires edited_body
  if (data.decision === 'edit_and_approve' && !data.edited_body) {
    return fail('validation', messages.promptProposals.errors.editedBodyRequired);
  }

  const now = deps.now ?? new Date();

  try {
    // Fetch proposal outside tx (read-only pre-check)
    const proposal = await deps.proposalRepo.findById(data.proposal_id);
    if (!proposal) {
      return fail('not_found', messages.promptProposals.errors.notFound);
    }
    if (proposal.status !== 'pending') {
      return fail('conflict', messages.promptProposals.errors.conflict);
    }

    if (data.decision === 'approve' || data.decision === 'edit_and_approve') {
      const body = data.edited_body ?? proposal.proposed_body;

      const newPrompt = await deps.runTransaction(async (tx) => {
        // アクティブ版を archived に遷移
        const currentActive = await tx.promptRepo.findActiveByRoleGenre({
          role: proposal.role,
          genre: proposal.genre,
        });

        if (currentActive) {
          await tx.promptRepo.update({
            where: { id: currentActive.id },
            data: { status: 'archived', archived_at: now },
          });
        }

        // 新バージョンを INSERT
        const newVersion = (currentActive?.version ?? 0) + 1;
        const created = await tx.promptRepo.create({
          data: {
            role: proposal.role,
            genre: proposal.genre,
            version: newVersion,
            body,
            placeholders_json: [],
            status: 'active',
            created_by: `optimizer:${data.proposal_id}`,
            activated_at: now,
          },
        });

        // proposal を approved に更新
        await tx.proposalRepo.update({
          where: { id: data.proposal_id },
          data: {
            status: 'approved',
            decided_by: deps.session.user.id,
            decided_at: now,
          },
        });

        await tx.auditLogRepo.create({
          data: {
            actor_id: deps.session.user.id,
            action: 'prompt.approve',
            target_kind: 'prompt_proposal',
            target_id: data.proposal_id,
            before_json: { status: 'pending' } as unknown as Prisma.InputJsonValue,
            after_json: {
              status: 'approved',
              new_prompt_id: created.id,
            } as unknown as Prisma.InputJsonValue,
          },
        });

        return created;
      });

      return ok({ new_prompt_id: newPrompt.id });
    } else {
      // reject — read-only, single-op, wrap in tx for consistency
      await deps.runTransaction(async (tx) => {
        await tx.proposalRepo.update({
          where: { id: data.proposal_id },
          data: {
            status: 'rejected',
            decided_by: deps.session.user.id,
            decided_at: now,
            rejection_note: data.rejection_note,
          },
        });

        await tx.auditLogRepo.create({
          data: {
            actor_id: deps.session.user.id,
            action: 'prompt.reject',
            target_kind: 'prompt_proposal',
            target_id: data.proposal_id,
            before_json: { status: 'pending' } as unknown as Prisma.InputJsonValue,
            after_json: {
              status: 'rejected',
              rejection_note: data.rejection_note ?? null,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      });

      return ok({});
    }
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.promptProposals.errors.unknown);
  }
}

// ---------------------------------------------------------------------------
// rollbackAutoApprovedCore
// ---------------------------------------------------------------------------

export async function rollbackAutoApprovedCore(
  input: unknown,
  deps: RollbackAutoApprovedDeps,
): Promise<ActionResult<{ new_prompt_id?: string }>> {
  const parsed = RollbackAutoApprovedInputSchema.safeParse(input);
  if (!parsed.success) {
    return fail('validation', messages.promptProposals.errors.validation, parsed.error.flatten());
  }

  const data = parsed.data;
  const now = deps.now ?? new Date();

  try {
    // Pre-check outside tx (read-only)
    const proposal = await deps.proposalRepo.findById(data.proposal_id);
    if (!proposal) {
      return fail('not_found', messages.promptProposals.errors.notFound);
    }

    // auto_approved かつ rollback_until > now() であること
    if (
      proposal.status !== 'auto_approved' ||
      !proposal.rollback_until ||
      proposal.rollback_until <= now
    ) {
      return fail('conflict', messages.promptProposals.errors.rollbackExpired);
    }

    await deps.runTransaction(async (tx) => {
      // 現在の active を archived に
      const currentActive = await tx.promptRepo.findActiveByRoleGenre({
        role: proposal.role,
        genre: proposal.genre,
      });

      if (currentActive) {
        await tx.promptRepo.update({
          where: { id: currentActive.id },
          data: { status: 'archived', archived_at: now },
        });

        // 1 つ前のバージョンを active 復元
        const previous = await tx.promptRepo.findPreviousVersion({
          role: proposal.role,
          genre: proposal.genre,
          currentVersion: currentActive.version,
        });

        if (previous) {
          await tx.promptRepo.update({
            where: { id: previous.id },
            data: { status: 'active', archived_at: null, activated_at: now },
          });
        }
      }

      // proposal を rejected に（ロールバック扱い）
      await tx.proposalRepo.update({
        where: { id: data.proposal_id },
        data: {
          status: 'rejected',
          decided_by: deps.session.user.id,
          decided_at: now,
          rejection_note: 'ロールバック',
        },
      });

      await tx.auditLogRepo.create({
        data: {
          actor_id: deps.session.user.id,
          action: 'prompt.rollback',
          target_kind: 'prompt_proposal',
          target_id: data.proposal_id,
          before_json: { status: 'auto_approved' } as unknown as Prisma.InputJsonValue,
          after_json: { status: 'rejected', rejection_note: 'ロールバック' } as unknown as Prisma.InputJsonValue,
        },
      });
    });

    return ok({});
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.promptProposals.errors.unknown);
  }
}
