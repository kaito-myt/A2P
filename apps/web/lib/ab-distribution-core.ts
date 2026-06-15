/**
 * A/B 配信コアロジック (T-11-06, F-031)
 *
 * `app/actions/prompt-proposals.ts` の startAbDistribution SA から呼ばれる。
 * 依存は DI で受け取り Vitest でユニットテスト可能にする。
 *
 * DB 永続化: AppSettings.ab_distribution_json (Json? 配列) に同 role×genre をアップサート。
 *
 * 設計根拠: docs/05 §4.3.11, SP-11 T-11-06 最終方針「手順 1〜5」
 */
import {
  isA2PError,
  fail,
  ok,
  type ActionResult,
} from '@a2p/contracts';
import { Prisma } from '@a2p/db';

import { StartAbDistributionInputSchema } from '@a2p/contracts/api/ab-distribution';
import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';
import { normalizeAbGenre, type AbDistributionConfig } from './ab-distribution-shared';

// ---------------------------------------------------------------------------
// 型定義 (re-export for backward compat)
// ---------------------------------------------------------------------------

export type { AbDistributionConfig };
export { normalizeAbGenre };

// ---------------------------------------------------------------------------
// DI boundary
// ---------------------------------------------------------------------------

export interface AppSettingsAbRow {
  id: string;
  ab_distribution_json: unknown;
}

export interface AppSettingsAbRepo {
  findUnique(args: { where: { id: string } }): Promise<AppSettingsAbRow | null>;
  update(args: {
    where: { id: string };
    data: Record<string, unknown>;
  }): Promise<AppSettingsAbRow>;
}

export interface AbAuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

export interface AbDistributionDeps {
  appSettingsRepo: AppSettingsAbRepo;
  auditLogRepo: AbAuditLogRepo;
  session: AuthenticatedSession;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * AppSettings.ab_distribution_json に同 role×genre をアップサートする。
 * 既存エントリがあれば上書き、なければ追加。
 * 設定変更を audit_log に記録する (settings-core のパターンに倣う)。
 */
export async function startAbDistributionCore(
  input: unknown,
  deps: AbDistributionDeps,
): Promise<ActionResult<void>> {
  const parsed = StartAbDistributionInputSchema.safeParse(input);
  if (!parsed.success) {
    return fail('validation', messages.abDistribution.errors.validation, parsed.error.flatten());
  }

  const { role, genre, baseline_id, candidate_id, ratio_candidate } = parsed.data;

  try {
    const current = await deps.appSettingsRepo.findUnique({ where: { id: 'singleton' } });

    const existingList = parseAbDistributionJson(current?.ab_distribution_json);
    const beforeList = [...existingList];

    // 同 role×genre をアップサート
    const idx = existingList.findIndex((e) => e.role === role && e.genre === genre);
    const newEntry: AbDistributionConfig = { role, genre, baseline_id, candidate_id, ratio_candidate };
    if (idx >= 0) {
      existingList[idx] = newEntry;
    } else {
      existingList.push(newEntry);
    }

    await deps.appSettingsRepo.update({
      where: { id: 'singleton' },
      data: {
        ab_distribution_json: existingList as unknown as Prisma.InputJsonValue,
      },
    });

    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'settings.update',
        target_kind: 'ab_distribution',
        target_id: `${role}:${genre}`,
        before_json: (beforeList.length > 0 ? beforeList : Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
        after_json: existingList as unknown as Prisma.InputJsonValue,
      },
    });

    return ok(undefined as void);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.abDistribution.errors.unknown);
  }
}

/**
 * 現在の A/B 配信設定を role×genre で取得する。
 * genre は null を渡してもよい（normalizeAbGenre で 'default' に正規化）。
 * 設定がなければ null を返す。
 */
export async function getAbDistributionForRole(
  role: string,
  genre: string | null,
  deps: Pick<AbDistributionDeps, 'appSettingsRepo'>,
): Promise<AbDistributionConfig | null> {
  const current = await deps.appSettingsRepo.findUnique({ where: { id: 'singleton' } });
  const list = parseAbDistributionJson(current?.ab_distribution_json);
  const normalizedGenre = normalizeAbGenre(genre);
  return list.find((e) => e.role === role && e.genre === normalizedGenre) ?? null;
}

/**
 * rand (0..1, DI で決定的に注入可) と ratio_candidate で baseline/candidate を選択する。
 * rand < ratio_candidate → candidate_id を返す。
 * 設定がなければ null を返す (呼び出し元が既存 active prompt_id を使う)。
 * genre は null を渡してもよい（normalizeAbGenre で 'default' に正規化）。
 */
export async function selectPromptId(
  role: string,
  genre: string | null,
  rand: number,
  deps: Pick<AbDistributionDeps, 'appSettingsRepo'>,
): Promise<string | null> {
  const config = await getAbDistributionForRole(role, genre, deps);
  if (!config) return null;
  return rand < config.ratio_candidate ? config.candidate_id : config.baseline_id;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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
