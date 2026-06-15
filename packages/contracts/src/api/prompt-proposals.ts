/**
 * prompt-proposals API 契約 (T-11-04)
 *
 * decideProposal / rollbackAutoApproved Server Action の入力スキーマ。
 * 設計根拠: docs/05 §4.3.12
 */
import { z } from 'zod';

export const DecideProposalInputSchema = z.object({
  proposal_id: z.string().min(1),
  decision: z.enum(['approve', 'reject', 'edit_and_approve']),
  /** edit_and_approve 時必須 */
  edited_body: z.string().optional(),
  rejection_note: z.string().max(1000).optional(),
});

export type DecideProposalInput = z.infer<typeof DecideProposalInputSchema>;

export const RollbackAutoApprovedInputSchema = z.object({
  proposal_id: z.string().min(1),
});

export type RollbackAutoApprovedInput = z.infer<typeof RollbackAutoApprovedInputSchema>;
