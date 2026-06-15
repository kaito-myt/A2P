/**
 * S-023 プロンプト改訂承認画面 (T-11-07) のシリアライズ / ビューヘルパ。
 *
 * RSC で Prisma PromptProposal + Prompt + AppSettings を Client Component に渡す際の
 * Date 正規化。settings-view / alerts-view と同パターン。
 *
 * 仕様根拠:
 *  - docs/04 S-023
 *  - docs/05 §4.3.12
 *  - SP-11 T-11-07
 */
import type { PrismaClient } from '@a2p/db';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProposalListItem {
  id: string;
  role: string;
  genre: string | null;
  source_version: number;
  status: string;
  rationale: string;
  expected_effect_json: unknown;
  created_at: string; // ISO8601
}

export interface ProposalDetail extends ProposalListItem {
  proposed_body: string;
  diff: string;
  sample_output: string | null;
  source_prompt_body: string;
  rollback_until: string | null; // ISO8601
}

export interface AutoApprovalStatus {
  enabled: boolean;
  rollback_h: number;
}

// ---------------------------------------------------------------------------
// Raw types (Prisma 戻り値)
// ---------------------------------------------------------------------------

interface RawProposalRow {
  id: string;
  role: string;
  genre: string | null;
  status: string;
  rationale: string;
  expected_effect_json: unknown;
  created_at: Date;
  source_prompt_id: string;
  sourcePrompt: {
    version: number;
    body: string;
  };
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

export async function listProposals(prisma: PrismaClient): Promise<ProposalListItem[]> {
  const rows = await prisma.promptProposal.findMany({
    orderBy: { created_at: 'desc' },
    include: {
      sourcePrompt: {
        select: { version: true, body: true },
      },
    },
  });

  return rows.map((r) => serializeListItem(r as unknown as RawProposalRow));
}

export async function getProposalDetail(
  id: string,
  prisma: PrismaClient,
): Promise<ProposalDetail | null> {
  const row = await prisma.promptProposal.findUnique({
    where: { id },
    include: {
      sourcePrompt: {
        select: { version: true, body: true },
      },
    },
  });

  if (!row) return null;

  const base = serializeListItem(row as unknown as RawProposalRow);
  return {
    ...base,
    proposed_body: row.proposed_body,
    diff: row.diff,
    sample_output: row.sample_output ?? null,
    source_prompt_body: (row as unknown as RawProposalRow).sourcePrompt.body,
    rollback_until: row.rollback_until ? row.rollback_until.toISOString() : null,
  };
}

export async function getAutoApprovalStatus(prisma: PrismaClient): Promise<AutoApprovalStatus> {
  const settings = await prisma.appSettings.findFirst({
    select: {
      prompt_auto_approval_enabled: true,
      prompt_auto_approval_rollback_h: true,
    },
  });

  return {
    enabled: settings?.prompt_auto_approval_enabled ?? false,
    rollback_h: settings?.prompt_auto_approval_rollback_h ?? 24,
  };
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function serializeListItem(r: RawProposalRow): ProposalListItem {
  return {
    id: r.id,
    role: r.role,
    genre: r.genre,
    source_version: r.sourcePrompt.version,
    status: r.status,
    rationale: r.rationale,
    expected_effect_json: r.expected_effect_json,
    created_at: r.created_at.toISOString(),
  };
}
