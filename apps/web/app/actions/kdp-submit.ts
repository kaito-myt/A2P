'use server';

/**
 * KDP 自動入稿 Server Action (T-08-09, F-041).
 *
 * Phase 1: 型定義とスタブのみ。実際の worker エンキューは SP-15 (Phase 3) で実装。
 * Phase 3 実装者は `submitToKdpCore` を埋め、fail → ok に差し替えるだけでよい。
 *
 * 仕様根拠: docs/05 §4.3.16
 */
import { z } from 'zod';
import { isA2PError, fail, type ActionResult } from '@a2p/contracts';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';

// ---------------------------------------------------------------------------
// Input schema — Phase 3 の呼出側はここを変更せずに実装できる。
// ---------------------------------------------------------------------------

export const submitToKdpInput = z.object({
  /** 入稿対象の書籍 ID リスト (1〜20 件)。 */
  book_ids: z.array(z.string().min(1)).min(1).max(20),
});

export type SubmitToKdpInput = z.infer<typeof submitToKdpInput>;

// ---------------------------------------------------------------------------
// Output types — docs/05 §4.3.16 に準拠。
// ---------------------------------------------------------------------------

export interface KdpSubmitJob {
  book_id: string;
  /** graphile-worker job ID (Phase 3 で設定される)。 */
  job_id: string;
}

export interface KdpSubmitBlocked {
  book_id: string;
  /** ブロック理由 (must コメント残等)。 */
  reason: string;
}

export interface SubmitToKdpOutput {
  jobs: KdpSubmitJob[];
  blocked: KdpSubmitBlocked[];
}

// ---------------------------------------------------------------------------
// Server Action
// ---------------------------------------------------------------------------

/**
 * SP-15 (Phase 3) で実装される KDP 自動入稿 SA のスタブ。
 *
 * Phase 1 では認証確認とバリデーションのみ行い、常に conflict を返す。
 * 呼出し側はこの SA の存在を前提に import できるが、SubmitToKdpButton は
 * disabled のためエンドユーザーは実行できない (T-08-03 参照)。
 */
export async function submitToKdp(
  input: unknown,
): Promise<ActionResult<SubmitToKdpOutput>> {
  // 1. 認証確認
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('auth', messages.auth.unauthorized);
  }

  // 2. 入力バリデーション
  const parsed = submitToKdpInput.safeParse(input);
  if (!parsed.success) {
    return fail(
      'validation',
      messages.kdpSubmit.errors.validation,
      parsed.error.flatten().fieldErrors,
    );
  }

  // 3. Phase 1 スタブ — SP-15 (F-041) で実装。絶対に enqueue しない。
  // Phase 3 実装者はここを削除し、worker job エンキュー処理に差し替える。
  return fail('conflict', messages.kdpSubmit.errors.phase3Unavailable);
}
