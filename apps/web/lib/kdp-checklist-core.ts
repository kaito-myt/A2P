/**
 * updateChecklist SA core logic (T-08-04, F-020).
 *
 * `app/actions/kdp-checklist.ts` (SA wrapper) から呼ばれる業務ロジック。
 * 依存は DI で受け取り Vitest でユニットテスト可能にする。
 *
 * 設計判断:
 *  - checklist_state_json は Record<field, { copied: boolean; checked: boolean; checked_at?: string }>
 *  - 1 フィールドのみ partial update (他フィールドは保持)
 *  - KdpSubmissionProgress が未存在の場合は upsert で新規作成
 *  - チェックボックストグルは高頻度 UI 操作のため audit_log には記録しない
 *    (docs/05 §13 申し送り 4 — 意味のある操作のみ記録する方針)
 *
 * 仕様根拠: docs/05 §4.3.16 / docs/02 F-020 / SP-08 T-08-04
 */
import { z } from 'zod';

import {
  isA2PError,
  fail,
  ok,
  type ActionResult,
} from '@a2p/contracts';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// zod schema (docs/05 §4.3.16)
// ---------------------------------------------------------------------------

export const UpdateChecklistInputSchema = z.object({
  book_id: z.string().min(1),
  /** フィールドキー: title | subtitle | author | description | category1 | category2 | keywords | price | cover_url | body_url */
  field: z.string().min(1),
  copied: z.boolean().optional(),
  checked: z.boolean().optional(),
});

export type UpdateChecklistInput = z.infer<typeof UpdateChecklistInputSchema>;

// ---------------------------------------------------------------------------
// checklist_state_json の内部型
// ---------------------------------------------------------------------------

export interface ChecklistFieldState {
  copied: boolean;
  checked: boolean;
  checked_at?: string;
}

export type ChecklistStateJson = Record<string, ChecklistFieldState>;

// ---------------------------------------------------------------------------
// DI boundary
// ---------------------------------------------------------------------------

export interface KdpSubmissionProgressRow {
  id: string;
  book_id: string;
  checklist_state_json: unknown;
}

export interface KdpSubmissionProgressRepo {
  findUnique(args: {
    where: { book_id: string };
    select: { id: true; book_id: true; checklist_state_json: true };
  }): Promise<KdpSubmissionProgressRow | null>;

  upsert(args: {
    where: { book_id: string };
    create: {
      book_id: string;
      checklist_state_json: ChecklistStateJson;
      screenshot_r2_keys: string[];
    };
    update: {
      checklist_state_json: ChecklistStateJson;
    };
  }): Promise<KdpSubmissionProgressRow>;
}

export interface BookExistsRepo {
  findUnique(args: {
    where: { id: string };
    select: { id: true };
  }): Promise<{ id: string } | null>;
}

export interface ChecklistDeps {
  kdpSubmissionProgressRepo: KdpSubmissionProgressRepo;
  bookRepo: BookExistsRepo;
  session: AuthenticatedSession;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export async function updateChecklistCore(
  raw: unknown,
  deps: ChecklistDeps,
): Promise<ActionResult<void>> {
  const parsed = UpdateChecklistInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      'validation',
      messages.kdpChecklist.errors.validation,
      parsed.error.flatten(),
    );
  }

  const input = parsed.data;
  const now = (deps.now ?? (() => new Date()))();

  try {
    // 書籍存在確認
    const book = await deps.bookRepo.findUnique({
      where: { id: input.book_id },
      select: { id: true },
    });
    if (!book) {
      return fail('not_found', messages.kdpChecklist.errors.bookNotFound);
    }

    // 既存 checklist_state_json を取得
    const existing = await deps.kdpSubmissionProgressRepo.findUnique({
      where: { book_id: input.book_id },
      select: { id: true, book_id: true, checklist_state_json: true },
    });

    // 既存 JSON を安全にパースし、partial merge する
    const currentState = parseChecklistState(existing?.checklist_state_json);
    const currentField = currentState[input.field] ?? { copied: false, checked: false };

    const updatedField: ChecklistFieldState = {
      copied: input.copied !== undefined ? input.copied : currentField.copied,
      checked: input.checked !== undefined ? input.checked : currentField.checked,
    };

    // checked が true になった時刻を記録
    if (updatedField.checked && input.checked === true) {
      updatedField.checked_at = now.toISOString();
    } else if (!updatedField.checked) {
      // チェックを外した場合は checked_at を除去
      delete updatedField.checked_at;
    } else if (currentField.checked_at) {
      // 変更なしの場合は既存 checked_at を保持
      updatedField.checked_at = currentField.checked_at;
    }

    const nextState: ChecklistStateJson = {
      ...currentState,
      [input.field]: updatedField,
    };

    await deps.kdpSubmissionProgressRepo.upsert({
      where: { book_id: input.book_id },
      create: {
        book_id: input.book_id,
        checklist_state_json: nextState,
        screenshot_r2_keys: [],
      },
      update: {
        checklist_state_json: nextState,
      },
    });

    return ok(undefined as void);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.kdpChecklist.errors.unknown);
  }
}

// ---------------------------------------------------------------------------
// Helper: DB から取得した unknown JSON を ChecklistStateJson として扱う
// ---------------------------------------------------------------------------

function parseChecklistState(raw: unknown): ChecklistStateJson {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  // 型アサーション: Prisma が保持する Json は実行時にこの形を保証している
  return raw as ChecklistStateJson;
}
