/**
 * docs/05 §6.1.2 / F-022 — `ModelAssignment` を役割×ジャンルで解決する。
 *
 * 優先順:
 *   1. role + genre (指定値) + status='active' に一致する行
 *   2. role + genre = NULL (全ジャンル既定) + status='active' に一致する行
 *   3. どちらも無ければ `ConfigError`
 *
 * prompt-loader (T-02-05) と同じフォールバック規約を採用する。
 *
 * WHY `nulls: 'last'` を必ず明示する:
 *   PostgreSQL の `ORDER BY ... DESC` 既定は **NULLS FIRST**。
 *   `orderBy: { genre: 'desc' }` だけでは genre=NULL 行が先頭に並び、
 *   genre 指定値が常に無視されるバグになる。
 *   よって `orderBy: { genre: { sort: 'desc', nulls: 'last' } }` と
 *   NULLS LAST を明示し、指定値 (非 null) → null fallback の順を保証する。
 */
import { ConfigError } from '@a2p/contracts/errors';
import type { AgentRole, Genre } from '@a2p/contracts/agents';
import { prisma as defaultPrisma } from '@a2p/db';

export interface LoadedAssignment {
  provider: string;
  model: string;
  /** 解決に使われた assignment ID — 監査ログ等で使える。 */
  id: string;
  /** 解決に使われた genre (null = 全ジャンル既定 fallback)。 */
  genre: Genre | null;
}

type SortOrder = 'asc' | 'desc';
type NullsOrder = 'first' | 'last';
type OrderBySpec = SortOrder | { sort: SortOrder; nulls?: NullsOrder };

interface ModelAssignmentRepo {
  findFirst(args: {
    where: {
      role: string;
      status: string;
      OR: Array<{ genre: string | null }>;
    };
    orderBy: { genre: OrderBySpec };
    select?: {
      id?: true;
      provider?: true;
      model?: true;
      genre?: true;
    };
  }): Promise<{
    id: string;
    provider: string;
    model: string;
    genre: string | null;
  } | null>;
}

export interface LoadModelAssignmentDeps {
  prisma?: { modelAssignment: ModelAssignmentRepo };
}

export async function loadModelAssignment(
  role: AgentRole,
  genre: Genre | null,
  deps: LoadModelAssignmentDeps = {},
): Promise<LoadedAssignment> {
  const repo =
    deps.prisma?.modelAssignment ??
    (defaultPrisma as unknown as { modelAssignment: ModelAssignmentRepo }).modelAssignment;

  // OR: genre 指定値 と null 既定の両方を引いて、orderBy で指定値 (非 null) を先頭に並べる。
  // WHY: PostgreSQL DESC 既定は NULLS FIRST。NULLS LAST を明示しないと
  // genre=null 行が先頭に並び、genre 指定値が常に無視されるバグになる。
  const row = await repo.findFirst({
    where: {
      role,
      status: 'active',
      OR: [{ genre }, { genre: null }],
    },
    orderBy: { genre: { sort: 'desc', nulls: 'last' } },
    select: { id: true, provider: true, model: true, genre: true },
  });

  if (!row) {
    throw new ConfigError(
      `no active ModelAssignment for role=${role} genre=${genre ?? 'null'}`,
      {
        userMessage: `${role} のモデル割当が見つかりません。設定画面から割り当ててください`,
      },
    );
  }

  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    genre: (row.genre as Genre | null) ?? null,
  };
}
