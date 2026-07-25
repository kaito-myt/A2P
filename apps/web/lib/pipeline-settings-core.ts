/**
 * パイプライン設定 (S-pipeline-settings) の読み書きコアロジック。
 *
 * 出版パイプラインの各工程を AI 判断で自動パスするか (人手承認ゲートを自動通過するか) を
 * AppSettings(singleton) に保存する。テーマ選定のみ、1日の自動生成数と方向性(フリーテキスト)も持つ。
 *
 * `app/actions/pipeline-settings.ts` (SA ラッパ) から呼ばれる。依存は DI で受け取り Vitest 可能にする。
 * 設計は settings-core.ts と同じ DI パターンだが、共有設定を壊さないよう独立モジュールにしている。
 *
 * 仕様根拠: docs/05 (パイプライン自動化ゲート) / docs/06 の人手ゲート定義
 */
import { z } from 'zod';

import { isA2PError, fail, ok, type ActionResult } from '@a2p/contracts';
import { Prisma } from '@a2p/db';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// 入力スキーマ (全フィールド optional — 部分更新可)
// ---------------------------------------------------------------------------

export const UpdatePipelineSettingsInputSchema = z.object({
  autopass_theme_enabled: z.boolean().optional(),
  pipeline_themes_per_day: z.number().int().min(1).max(30).optional(),
  pipeline_theme_direction: z.string().max(2000).optional(),
  autopass_outline_enabled: z.boolean().optional(),
  autopass_content_enabled: z.boolean().optional(),
  autopass_cover_enabled: z.boolean().optional(),
  autopass_kdp_enabled: z.boolean().optional(),
});

export type UpdatePipelineSettingsInput = z.infer<typeof UpdatePipelineSettingsInputSchema>;

// ---------------------------------------------------------------------------
// ビュー型 (RSC → Client)
// ---------------------------------------------------------------------------

export interface PipelineSettingsView {
  autopass_theme_enabled: boolean;
  pipeline_themes_per_day: number;
  pipeline_theme_direction: string;
  autopass_outline_enabled: boolean;
  autopass_content_enabled: boolean;
  autopass_cover_enabled: boolean;
  autopass_kdp_enabled: boolean;
}

interface RawPipelineSettings {
  autopass_theme_enabled: boolean;
  pipeline_themes_per_day: number;
  pipeline_theme_direction: string;
  autopass_outline_enabled: boolean;
  autopass_content_enabled: boolean;
  autopass_cover_enabled: boolean;
  autopass_kdp_enabled: boolean;
}

export function serializePipelineSettings(raw: RawPipelineSettings): PipelineSettingsView {
  return {
    autopass_theme_enabled: Boolean(raw.autopass_theme_enabled),
    pipeline_themes_per_day: Number(raw.pipeline_themes_per_day ?? 3),
    pipeline_theme_direction: raw.pipeline_theme_direction ?? '',
    autopass_outline_enabled: Boolean(raw.autopass_outline_enabled),
    autopass_content_enabled: Boolean(raw.autopass_content_enabled),
    autopass_cover_enabled: Boolean(raw.autopass_cover_enabled),
    autopass_kdp_enabled: Boolean(raw.autopass_kdp_enabled),
  };
}

// ---------------------------------------------------------------------------
// DI 境界
// ---------------------------------------------------------------------------

export interface PipelineAppSettingsRepo {
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
}

export interface PipelineAuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

export interface PipelineSettingsDeps {
  appSettingsRepo: PipelineAppSettingsRepo;
  auditLogRepo: PipelineAuditLogRepo;
  session: AuthenticatedSession;
}

// ---------------------------------------------------------------------------
// コア
// ---------------------------------------------------------------------------

export async function updatePipelineSettingsCore(
  input: unknown,
  deps: PipelineSettingsDeps,
): Promise<ActionResult<void>> {
  const parsed = UpdatePipelineSettingsInputSchema.safeParse(input);
  if (!parsed.success) {
    return fail('validation', messages.pipelineSettings.errors.validation, parsed.error.flatten());
  }
  const data = parsed.data;

  const updateData: Record<string, unknown> = {};
  if (data.autopass_theme_enabled !== undefined) updateData.autopass_theme_enabled = data.autopass_theme_enabled;
  if (data.pipeline_themes_per_day !== undefined) updateData.pipeline_themes_per_day = data.pipeline_themes_per_day;
  if (data.pipeline_theme_direction !== undefined) updateData.pipeline_theme_direction = data.pipeline_theme_direction.trim();
  if (data.autopass_outline_enabled !== undefined) updateData.autopass_outline_enabled = data.autopass_outline_enabled;
  if (data.autopass_content_enabled !== undefined) updateData.autopass_content_enabled = data.autopass_content_enabled;
  if (data.autopass_cover_enabled !== undefined) updateData.autopass_cover_enabled = data.autopass_cover_enabled;
  if (data.autopass_kdp_enabled !== undefined) updateData.autopass_kdp_enabled = data.autopass_kdp_enabled;

  if (Object.keys(updateData).length === 0) {
    return ok(undefined as void);
  }

  try {
    await deps.appSettingsRepo.update({ where: { id: 'singleton' }, data: updateData });
    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'pipeline_settings.update',
        target_kind: 'app_settings',
        target_id: 'singleton',
        after_json: updateData as unknown as Prisma.InputJsonValue,
      },
    });
    return ok(undefined as void);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.pipelineSettings.errors.unknown);
  }
}
