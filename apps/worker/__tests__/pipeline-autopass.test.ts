import { describe, expect, it } from 'vitest';

import {
  readPipelineAutopass,
  type PipelineAutopassPrisma,
} from '../src/tasks/lib/pipeline-autopass.js';

function makePrisma(
  row: Record<string, unknown> | null,
  opts?: { throwErr?: Error },
): PipelineAutopassPrisma {
  return {
    appSettings: {
      findUnique: async () => {
        if (opts?.throwErr) throw opts.throwErr;
        return row;
      },
    },
  };
}

describe('readPipelineAutopass', () => {
  it('AppSettings 行が無い場合は全項目 OFF の安全な既定値を返す', async () => {
    const prisma = makePrisma(null);
    const flags = await readPipelineAutopass(prisma);
    expect(flags).toEqual({
      autopass_theme_enabled: false,
      pipeline_themes_per_day: 3,
      pipeline_theme_direction: '',
      pipeline_theme_cron: '0 22 * * *',
      autopass_outline_enabled: false,
      autopass_content_enabled: false,
      autopass_cover_enabled: false,
      autopass_kdp_enabled: false,
    });
  });

  it('クエリが失敗した場合も安全な既定値を返す (throw しない)', async () => {
    const prisma = makePrisma(null, { throwErr: new Error('db down') });
    await expect(readPipelineAutopass(prisma)).resolves.toEqual({
      autopass_theme_enabled: false,
      pipeline_themes_per_day: 3,
      pipeline_theme_direction: '',
      pipeline_theme_cron: '0 22 * * *',
      autopass_outline_enabled: false,
      autopass_content_enabled: false,
      autopass_cover_enabled: false,
      autopass_kdp_enabled: false,
    });
  });

  it('全フィールドが設定済みの行はそのまま反映する', async () => {
    const prisma = makePrisma({
      autopass_theme_enabled: true,
      pipeline_themes_per_day: 10,
      pipeline_theme_direction: '副業・資産形成系',
      pipeline_theme_cron: '30 21 * * *',
      autopass_outline_enabled: true,
      autopass_content_enabled: true,
      autopass_cover_enabled: true,
      autopass_kdp_enabled: true,
    });
    const flags = await readPipelineAutopass(prisma);
    expect(flags).toEqual({
      autopass_theme_enabled: true,
      pipeline_themes_per_day: 10,
      pipeline_theme_direction: '副業・資産形成系',
      pipeline_theme_cron: '30 21 * * *',
      autopass_outline_enabled: true,
      autopass_content_enabled: true,
      autopass_cover_enabled: true,
      autopass_kdp_enabled: true,
    });
  });

  it('個別フィールドが欠落/型不正でもそのフィールドだけ既定値にフォールバックする', async () => {
    const prisma = makePrisma({
      autopass_theme_enabled: true,
      // pipeline_themes_per_day 欠落 → 既定 3
      pipeline_theme_direction: 123, // 型不正 → 既定 ''
      pipeline_theme_cron: '   ', // 空白のみ → 既定
      autopass_outline_enabled: true,
    });
    const flags = await readPipelineAutopass(prisma);
    expect(flags.autopass_theme_enabled).toBe(true);
    expect(flags.pipeline_themes_per_day).toBe(3);
    expect(flags.pipeline_theme_direction).toBe('');
    expect(flags.pipeline_theme_cron).toBe('0 22 * * *');
    expect(flags.autopass_outline_enabled).toBe(true);
    expect(flags.autopass_content_enabled).toBe(false);
    expect(flags.autopass_cover_enabled).toBe(false);
    expect(flags.autopass_kdp_enabled).toBe(false);
  });
});
