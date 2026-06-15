/**
 * UC-03 プロンプト改訂サイクル E2E テスト用 seed fixture (T-11-09)
 *
 * - Prompt レコード（active, role='writer', genre='business'）を投入
 * - PromptProposal を pending / auto_approved で投入
 * - EvalResult 10 件（テスト用スコアデータ）を投入
 *
 * 仕様: SP-11 T-11-09 § 実装指示 §1
 */
import { prisma, type Prisma } from '@a2p/db';

const TEST_PREFIX = 'e2e-uc03-';

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function cleanupUC03Data(): Promise<void> {
  // PromptProposal を削除 (Cascade で自動削除されないため明示的に)
  await prisma.promptProposal
    .deleteMany({
      where: {
        role: { startsWith: TEST_PREFIX },
      },
    })
    .catch(() => undefined);

  // Prompt を削除
  await prisma.prompt
    .deleteMany({
      where: {
        role: { startsWith: TEST_PREFIX },
      },
    })
    .catch(() => undefined);

  // EvalResult を削除
  const evalResults = await prisma.evalResult
    .findMany({
      where: {
        proposal_context_json: {
          path: ['_e2e_marker'],
          equals: 'uc03-spec',
        },
      },
      select: { id: true },
    })
    .catch(() => [] as Array<{ id: string }>);

  if (evalResults.length > 0) {
    await prisma.evalResult
      .deleteMany({
        where: {
          id: {
            in: evalResults.map((r) => r.id),
          },
        },
      })
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Seed: pending proposal
// ---------------------------------------------------------------------------

export async function seedPendingProposal(): Promise<{
  promptId: string;
  proposalId: string;
}> {
  // 既存 Prompt を作成または取得
  const sourcePrompt = await prisma.prompt.create({
    data: {
      role: `${TEST_PREFIX}writer`,
      genre: 'business',
      version: 1,
      body: 'You are a business book writer. Write compelling content.',
      placeholders_json: ['title', 'outline'] as unknown as Prisma.InputJsonValue,
      status: 'active',
      created_by: 'human',
      activated_at: new Date(),
    },
  });

  // pending の PromptProposal を投入
  const proposal = await prisma.promptProposal.create({
    data: {
      source_prompt_id: sourcePrompt.id,
      role: sourcePrompt.role,
      genre: sourcePrompt.genre,
      proposed_body: 'You are a business book writer. Write compelling, engaging content with clear structure.',
      diff: '- Write compelling content.\n+ Write compelling, engaging content with clear structure.',
      rationale: 'Add emphasis on engagement and structure for better reader retention.',
      expected_effect_json: {
        score_delta: 2.5,
        sales_delta_pct: 3.2,
      } as unknown as Prisma.InputJsonValue,
      sample_output: 'Sample business book chapter content here.',
      status: 'pending',
    },
  });

  return {
    promptId: sourcePrompt.id,
    proposalId: proposal.id,
  };
}

// ---------------------------------------------------------------------------
// Seed: auto_approved proposal with rollback_until
// ---------------------------------------------------------------------------

export async function seedAutoApprovedProposal(opts: {
  rollback_until_offset_h: number; // +12 for future, -1 for past
}): Promise<{
  promptId: string;
  proposalId: string;
}> {
  // 既存 Prompt を作成
  const sourcePrompt = await prisma.prompt.create({
    data: {
      role: `${TEST_PREFIX}writer`,
      genre: 'business',
      version: 1,
      body: 'You are a business book writer. Write engaging content.',
      placeholders_json: ['title', 'outline'] as unknown as Prisma.InputJsonValue,
      status: 'active',
      created_by: 'human',
      activated_at: new Date(),
    },
  });

  // rollback_until を計算
  const rollbackUntil = new Date(Date.now() + opts.rollback_until_offset_h * 60 * 60 * 1000);

  // auto_approved の PromptProposal を投入
  const proposal = await prisma.promptProposal.create({
    data: {
      source_prompt_id: sourcePrompt.id,
      role: sourcePrompt.role,
      genre: sourcePrompt.genre,
      proposed_body: 'You are a business book writer. Write engaging, high-quality content.',
      diff: '- Write engaging content.\n+ Write engaging, high-quality content.',
      rationale: 'Auto-approved: Score improvement confirmed.',
      expected_effect_json: {
        score_delta: 1.8,
        sales_delta_pct: 2.1,
      } as unknown as Prisma.InputJsonValue,
      sample_output: 'Auto-approved sample output.',
      status: 'auto_approved',
      decided_by: 'auto',
      decided_at: new Date(),
      rollback_until: rollbackUntil,
    },
  });

  return {
    promptId: sourcePrompt.id,
    proposalId: proposal.id,
  };
}

// ---------------------------------------------------------------------------
// Seed: EvalResult (for Quality Judge context)
// ---------------------------------------------------------------------------

export async function seedEvalResults(): Promise<void> {
  const evalResults = [];
  for (let i = 0; i < 10; i++) {
    evalResults.push({
      proposal_context_json: {
        _e2e_marker: 'uc03-spec',
        iteration: i,
      } as unknown as Prisma.InputJsonValue,
      quality_score: 7.5 + Math.random() * 2, // 7.5-9.5
      created_at: new Date(Date.now() - (10 - i) * 24 * 60 * 60 * 1000),
    });
  }

  await prisma.evalResult.createMany({
    data: evalResults,
  });
}
