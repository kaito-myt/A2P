/**
 * docs/06 P4 増分5 — org ロールのモデル最適化 bakeoff 起動のコアロジック。
 *
 * 現行割当＋モデルカタログから候補モデルを組み、代表入力で BakeoffRun を作成して
 * bakeoff.run を enqueue する。完了後は worker が org.bakeoff.recommend で切替提案を起票する。
 * 実 IO（prisma/enqueue）は deps 経由で DI 可能にする。
 */
import { z } from 'zod';

import { fail, ok, type ActionResult } from '@a2p/contracts';
import { isOrgBakeoffRole, orgBakeoffSampleInput } from '@a2p/contracts/org';

import { messages } from '@/lib/messages';

const m = messages.org.bakeoff;

/** 1 ラン最大候補数（bakeoff 側上限 8 に対し安全側）。 */
const MAX_CANDIDATES = 4;

export interface OrgBakeoffDeps {
  assignmentRepo: {
    findFirst: (args: {
      where: { role: string; genre: null; status: string };
      select: { provider: true; model: true };
    }) => Promise<{ provider: string; model: string } | null>;
  };
  catalogRepo: {
    findMany: (args: {
      where: { is_current: boolean };
      select: { provider: true; model: true };
    }) => Promise<Array<{ provider: string; model: string }>>;
  };
  bakeoffRunRepo: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
  session: { user: { id: string } };
  enqueue: (task: string, payload: unknown) => Promise<void>;
}

const LaunchSchema = z.object({ role: z.string().min(1) });

export async function launchOrgModelBakeoffCore(
  input: unknown,
  deps: OrgBakeoffDeps,
): Promise<ActionResult<{ run_id: string; candidates: number }>> {
  const parsed = LaunchSchema.safeParse(input);
  if (!parsed.success || !isOrgBakeoffRole(parsed.data.role)) {
    return fail('validation', m.error);
  }
  const { role } = parsed.data;

  const current = await deps.assignmentRepo.findFirst({
    where: { role, genre: null, status: 'active' },
    select: { provider: true, model: true },
  });

  const catalog = await deps.catalogRepo.findMany({
    where: { is_current: true },
    select: { provider: true, model: true },
  });

  // 候補: 現行を先頭に、カタログから重複しないものを MAX まで。
  const seen = new Set<string>();
  const candidates: Array<{ provider: string; model: string }> = [];
  const push = (c: { provider: string; model: string }) => {
    const key = `${c.provider}/${c.model}`;
    if (seen.has(key) || candidates.length >= MAX_CANDIDATES) return;
    seen.add(key);
    candidates.push(c);
  };
  if (current) push(current);
  for (const c of catalog) push(c);

  if (candidates.length < 2) {
    // 比較対象が 1 つ以下ではバエオフの意味がない。
    return fail('validation', m.notEnoughCandidates);
  }

  const run = await deps.bakeoffRunRepo.create({
    data: {
      role,
      genre: null,
      input_label: `org-optimize:${role}`,
      input_json: { user: orgBakeoffSampleInput(role), candidates, org_optimize: true },
      status: 'queued',
    },
  });

  await deps.enqueue('bakeoff.run', { run_id: run.id });
  return ok({ run_id: run.id, candidates: candidates.length });
}
