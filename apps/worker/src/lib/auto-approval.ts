/**
 * F-030 自動承認判定 (T-11-05)
 *
 * checkAutoApproval(proposalId) を呼ぶと:
 *   1. AppSettings.prompt_auto_approval_enabled が false → 即 false
 *   2. proposal.source_prompt_id から role, genre を取得
 *   3. created_by='optimizer:<proposalId>' の prompt_version を探す
 *      （proposal 承認後に INSERT されるもの。未承認時は 0 件 → false）
 *   4. その prompt_version_id を prompt_version_ids_json[role] に持つ
 *      eval_results を judged_at 昇順で最大 5 件取得
 *   5. 5 件 AND スコア単調増加 → shouldAutoApprove:true + rollback_until 計算
 *      それ以外 → false
 *
 * 条件成立時は呼び出し元 (optimizer-prompt-generate.ts) で
 * prisma.$transaction を使って原子的な承認フローを実行する。
 *
 * docs/05 §3 AppSettings / PromptProposal / Prompt / EvalResult 参照。
 */
import { prisma as defaultPrisma } from '@a2p/db';

// ---------------------------------------------------------------------------
// Prisma サブセット I/F (テスト可能な最小 surface)
// ---------------------------------------------------------------------------

export interface AutoApprovalPrisma {
  appSettings: {
    findUnique: (args: {
      where: { id: string };
      select: { prompt_auto_approval_enabled: true; prompt_auto_approval_rollback_h: true };
    }) => Promise<{
      prompt_auto_approval_enabled: boolean;
      prompt_auto_approval_rollback_h: number;
    } | null>;
  };
  promptProposal: {
    findUnique: (args: {
      where: { id: string };
      select: { source_prompt_id: true; role: true; genre: true; status: true };
    }) => Promise<{
      source_prompt_id: string;
      role: string;
      genre: string | null;
      status: string;
    } | null>;
  };
  prompt: {
    findMany: (args: {
      where: { created_by: string };
      select: { id: true };
    }) => Promise<Array<{ id: string }>>;
  };
  evalResult: {
    findMany: (args: {
      where: Record<string, unknown>;
      select: {
        score_total: true;
        prompt_version_ids_json: true;
        judged_at: true;
      };
      orderBy: { judged_at: 'asc' | 'desc' };
      take: number;
    }) => Promise<
      Array<{
        score_total: number;
        prompt_version_ids_json: unknown;
        judged_at: Date;
      }>
    >;
  };
  prompt_version?: never; // 誤字防止
  // 自動承認フロー用
  $transaction: <T>(fn: (tx: AutoApprovalTransactionPrisma) => Promise<T>) => Promise<T>;
}

/** $transaction コールバック内で使う最小 I/F */
export interface AutoApprovalTransactionPrisma {
  prompt: {
    findFirst: (args: {
      where: { role: string; genre: string | null; status: string };
      select: { id: true; version: true };
      orderBy: { version: 'desc' };
    }) => Promise<{ id: string; version: number } | null>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<unknown>;
    create: (args: {
      data: Record<string, unknown>;
    }) => Promise<{ id: string }>;
  };
  promptProposal: {
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<unknown>;
  };
  auditLog: {
    create: (args: {
      data: Record<string, unknown>;
    }) => Promise<unknown>;
  };
}

export interface AutoApprovalDeps {
  prisma?: AutoApprovalPrisma;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// checkAutoApproval
// ---------------------------------------------------------------------------

/**
 * F-030 自動承認判定。
 * 結果が shouldAutoApprove:true の場合、呼び出し元は
 * performAutoApproval() を続けて呼ぶか、本関数内のフローを利用する。
 *
 * T-11-05 では optimizer-prompt-generate.ts の末尾で呼ばれ、
 * 通常は 0 冊時点 (生成直後) のため false を返す。
 */
export async function checkAutoApproval(
  proposalId: string,
  deps?: AutoApprovalDeps,
): Promise<{ shouldAutoApprove: boolean; rollback_until?: Date }> {
  const prisma = (deps?.prisma ?? defaultPrisma) as unknown as AutoApprovalPrisma;
  const now = deps?.now ?? (() => new Date());

  // 1. AppSettings 確認
  const settings = await prisma.appSettings.findUnique({
    where: { id: 'singleton' },
    select: { prompt_auto_approval_enabled: true, prompt_auto_approval_rollback_h: true },
  });
  if (!settings?.prompt_auto_approval_enabled) {
    return { shouldAutoApprove: false };
  }
  const rollbackH = settings.prompt_auto_approval_rollback_h;

  // 2. proposal から role, genre を取得
  const proposal = await prisma.promptProposal.findUnique({
    where: { id: proposalId },
    select: { source_prompt_id: true, role: true, genre: true, status: true },
  });
  if (!proposal) {
    return { shouldAutoApprove: false };
  }

  const { role, genre } = proposal;

  // 3. proposal 承認後に INSERT された prompt_version を探す
  //    created_by = 'optimizer:<proposalId>' が命名規約 (prompt-proposals-core.ts 参照)
  const newPromptVersions = await prisma.prompt.findMany({
    where: { created_by: `optimizer:${proposalId}` },
    select: { id: true },
  });
  if (newPromptVersions.length === 0) {
    // 未承認 or 承認後の prompt が未 INSERT → 0 件 → false
    return { shouldAutoApprove: false };
  }

  // 複数の場合は最初の 1 件（通常は 1 件のみ）
  const newPromptId = newPromptVersions[0]!.id;

  // 4. その prompt_version_id を [role] に持つ eval_results を judged_at 昇順 5 件取得
  //    JSON カラムのためアプリ層でフィルタ
  const allEvals = await prisma.evalResult.findMany({
    where: {},
    select: {
      score_total: true,
      prompt_version_ids_json: true,
      judged_at: true,
    },
    orderBy: { judged_at: 'asc' },
    take: 100, // 広めに取ってアプリ層でフィルタ
  });

  // prompt_version_ids_json[role] === newPromptId のもので filter
  const filtered = allEvals.filter((e) => {
    const pvIds = e.prompt_version_ids_json as Record<string, string>;
    return pvIds[role] === newPromptId;
  });

  if (filtered.length < 5) {
    return { shouldAutoApprove: false };
  }

  // 直近 5 件（昇順取得しているので末尾 5 件が直近）
  const recent5 = filtered.slice(-5);

  // 5. 単調増加チェック (score[i+1] >= score[i])
  const isMonotonicallyIncreasing = recent5.every((item, idx) => {
    if (idx === 0) return true;
    return item.score_total >= recent5[idx - 1]!.score_total;
  });

  if (!isMonotonicallyIncreasing) {
    return { shouldAutoApprove: false };
  }

  const currentNow = now();
  const rollbackUntil = new Date(currentNow.getTime() + rollbackH * 3_600_000);

  return { shouldAutoApprove: true, rollback_until: rollbackUntil };
}

// ---------------------------------------------------------------------------
// performAutoApproval
// ---------------------------------------------------------------------------

/**
 * checkAutoApproval が true を返した後に呼び出す自動承認フロー。
 * prisma.$transaction で原子的に実行:
 *   1. 現 active prompt を archived に
 *   2. 新 prompt_version INSERT (created_by='optimizer:<proposalId>')
 *   3. PromptProposal UPDATE: status='auto_approved', decided_by='auto'
 *   4. AuditLog INSERT: actor_id=null, action='prompt.approve', before_json.trigger='auto'
 */
export async function performAutoApproval(
  proposalId: string,
  opts: {
    role: string;
    genre: string | null;
    proposedBody: string;
    rollbackUntil: Date;
    now: Date;
  },
  prisma: AutoApprovalPrisma,
): Promise<{ newPromptId: string }> {
  return prisma.$transaction(async (tx) => {
    // 現 active を archived に
    const currentActive = await tx.prompt.findFirst({
      where: { role: opts.role, genre: opts.genre, status: 'active' },
      select: { id: true, version: true },
      orderBy: { version: 'desc' },
    });

    if (currentActive) {
      await tx.prompt.update({
        where: { id: currentActive.id },
        data: { status: 'archived', archived_at: opts.now },
      });
    }

    // 新版 INSERT
    const newVersion = (currentActive?.version ?? 0) + 1;
    const created = await tx.prompt.create({
      data: {
        role: opts.role,
        genre: opts.genre,
        version: newVersion,
        body: opts.proposedBody,
        placeholders_json: [],
        status: 'active',
        created_by: `optimizer:${proposalId}`,
        activated_at: opts.now,
      },
    });

    // PromptProposal → auto_approved
    await tx.promptProposal.update({
      where: { id: proposalId },
      data: {
        status: 'auto_approved',
        decided_by: 'auto',
        decided_at: opts.now,
        rollback_until: opts.rollbackUntil,
      },
    });

    // AuditLog
    await tx.auditLog.create({
      data: {
        actor_id: null,
        action: 'prompt.approve',
        target_kind: 'prompt_proposal',
        target_id: proposalId,
        before_json: { status: 'pending', trigger: 'auto' },
        after_json: {
          status: 'auto_approved',
          new_prompt_id: created.id,
          rollback_until: opts.rollbackUntil.toISOString(),
        },
      },
    });

    return { newPromptId: created.id };
  });
}
