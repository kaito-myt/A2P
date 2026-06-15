/**
 * S-022 プロンプト管理画面 (T-11-08) のシリアライズ / ビューヘルパ。
 *
 * RSC で Prisma Prompt + AppSettings を Client Component に渡す際の
 * Date 正規化と A/B 配信設定取得。
 *
 * 仕様根拠:
 *  - docs/04 S-022
 *  - docs/05 §4.3.11
 *  - SP-11 T-11-08
 */
import type { PrismaClient } from '@a2p/db';
import { normalizeAbGenre, type AbDistributionConfig } from './ab-distribution-shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptListItem {
  id: string;
  role: string;
  genre: string | null;
  version: number;
  status: string;
  created_by: string;
  activated_at: string | null;
  archived_at: string | null;
  created_at: string;
}

export interface PromptVersionHistory {
  id: string;
  version: number;
  status: string;
  created_by: string;
  activated_at: string | null;
  archived_at: string | null;
  body: string;
  placeholders_json: unknown;
}

export interface PromptListWithAb extends PromptListItem {
  ab_distribution: AbDistributionConfig | null;
}

export interface AbDistributionViewData {
  current: AbDistributionConfig | null;
  candidates: PromptListItem[];
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * 全ての active プロンプト（役割×ジャンルの代表）を列挙する。
 */
export async function listActivePrompts(prisma: PrismaClient): Promise<PromptListItem[]> {
  const rows = await prisma.prompt.findMany({
    where: { status: 'active' },
    orderBy: [{ role: 'asc' }, { genre: 'asc' }],
  });

  return rows.map(serializePromptItem);
}

/**
 * 同 role×genre の全バージョン履歴を取得する (active + archived)。
 */
export async function getPromptVersionHistory(
  role: string,
  genre: string | null,
  prisma: PrismaClient,
): Promise<PromptVersionHistory[]> {
  const rows = await prisma.prompt.findMany({
    where: { role, genre: genre ?? null },
    orderBy: { version: 'desc' },
  });

  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    status: r.status,
    created_by: r.created_by,
    activated_at: r.activated_at ? r.activated_at.toISOString() : null,
    archived_at: r.archived_at ? r.archived_at.toISOString() : null,
    body: r.body,
    placeholders_json: r.placeholders_json,
  }));
}

/**
 * A/B 配信設定表示用データを返す。
 * - current: 現在の role×genre の A/B 配信設定 (null = 未設定)
 * - candidates: 同 role×genre の archived + active プロンプト候補一覧 (baseline / candidate 選択用)
 */
export async function getAbDistributionViewData(
  role: string,
  genre: string | null,
  prisma: PrismaClient,
): Promise<AbDistributionViewData> {
  const [settings, candidateRows] = await Promise.all([
    prisma.appSettings.findUnique({
      where: { id: 'singleton' },
      select: { ab_distribution_json: true },
    }),
    prisma.prompt.findMany({
      where: {
        role,
        genre: genre ?? null,
        status: { in: ['active', 'archived'] },
      },
      orderBy: { version: 'desc' },
    }),
  ]);

  const abList = parseAbDistributionJson(settings?.ab_distribution_json);
  const genreKey = normalizeAbGenre(genre);
  const current = abList.find((e) => e.role === role && e.genre === genreKey) ?? null;

  return {
    current,
    candidates: candidateRows.map(serializePromptItem),
  };
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function serializePromptItem(r: {
  id: string;
  role: string;
  genre: string | null;
  version: number;
  status: string;
  created_by: string;
  activated_at: Date | null;
  archived_at: Date | null;
  created_at: Date;
}): PromptListItem {
  return {
    id: r.id,
    role: r.role,
    genre: r.genre,
    version: r.version,
    status: r.status,
    created_by: r.created_by,
    activated_at: r.activated_at ? r.activated_at.toISOString() : null,
    archived_at: r.archived_at ? r.archived_at.toISOString() : null,
    created_at: r.created_at.toISOString(),
  };
}

function parseAbDistributionJson(raw: unknown): AbDistributionConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isAbDistributionConfig);
}

function isAbDistributionConfig(v: unknown): v is AbDistributionConfig {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.role === 'string' &&
    typeof o.genre === 'string' &&
    typeof o.baseline_id === 'string' &&
    typeof o.candidate_id === 'string' &&
    typeof o.ratio_candidate === 'number'
  );
}
