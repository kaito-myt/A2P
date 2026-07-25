import { describe, it, expect, vi } from 'vitest';

import {
  updatePipelineSettingsCore,
  serializePipelineSettings,
  UpdatePipelineSettingsInputSchema,
  type PipelineSettingsDeps,
} from '@/lib/pipeline-settings-core';

function deps(overrides: Partial<PipelineSettingsDeps> = {}): {
  deps: PipelineSettingsDeps;
  updates: Array<{ where: unknown; data: Record<string, unknown> }>;
  audits: unknown[];
} {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  const audits: unknown[] = [];
  const d: PipelineSettingsDeps = {
    appSettingsRepo: {
      update: vi.fn(async (a: { where: unknown; data: Record<string, unknown> }) => {
        updates.push(a);
        return {};
      }),
    },
    auditLogRepo: { create: vi.fn(async (a: unknown) => { audits.push(a); return {}; }) },
    session: { user: { id: 'u1' } } as PipelineSettingsDeps['session'],
    ...overrides,
  };
  return { deps: d, updates, audits };
}

describe('serializePipelineSettings', () => {
  it('boolean/number/text を正規化しデフォルトを埋める', () => {
    const v = serializePipelineSettings({
      autopass_theme_enabled: true,
      pipeline_themes_per_day: 5,
      pipeline_theme_direction: '実用書',
      autopass_outline_enabled: false,
      autopass_content_enabled: true,
      autopass_cover_enabled: false,
      autopass_kdp_enabled: true,
    });
    expect(v.autopass_theme_enabled).toBe(true);
    expect(v.pipeline_themes_per_day).toBe(5);
    expect(v.pipeline_theme_direction).toBe('実用書');
    expect(v.autopass_kdp_enabled).toBe(true);
  });
});

describe('UpdatePipelineSettingsInputSchema', () => {
  it('themes_per_day は 1..30 に制限', () => {
    expect(UpdatePipelineSettingsInputSchema.safeParse({ pipeline_themes_per_day: 0 }).success).toBe(false);
    expect(UpdatePipelineSettingsInputSchema.safeParse({ pipeline_themes_per_day: 31 }).success).toBe(false);
    expect(UpdatePipelineSettingsInputSchema.safeParse({ pipeline_themes_per_day: 3 }).success).toBe(true);
  });
});

describe('updatePipelineSettingsCore', () => {
  it('指定フィールドのみ更新し audit を残す', async () => {
    const { deps: d, updates, audits } = deps();
    const res = await updatePipelineSettingsCore(
      { autopass_outline_enabled: true, pipeline_theme_direction: '  お金・健康  ' },
      d,
    );
    expect(res.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.where).toEqual({ id: 'singleton' });
    expect(updates[0]!.data.autopass_outline_enabled).toBe(true);
    expect(updates[0]!.data.pipeline_theme_direction).toBe('お金・健康'); // trimmed
    expect(updates[0]!.data.autopass_theme_enabled).toBeUndefined(); // not provided → not written
    expect(audits).toHaveLength(1);
  });

  it('空入力なら更新しない', async () => {
    const { deps: d, updates } = deps();
    const res = await updatePipelineSettingsCore({}, d);
    expect(res.ok).toBe(true);
    expect(updates).toHaveLength(0);
  });

  it('不正な themes_per_day は validation エラー', async () => {
    const { deps: d } = deps();
    const res = await updatePipelineSettingsCore({ pipeline_themes_per_day: 99 }, d);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('validation');
  });
});
