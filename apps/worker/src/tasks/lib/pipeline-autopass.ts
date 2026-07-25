/**
 * パイプライン設定 (S-pipeline-settings) の自動パスフラグ読み取りヘルパー。
 *
 * `apps/web/lib/pipeline-settings-core.ts` が書き込む AppSettings(singleton) の
 * autopass_* / pipeline_theme_* フィールドを、各 pipeline worker task
 * (writer.outline / editor / judge / theme.auto) から共通で読み出す。
 *
 * AppSettings 行が無い場合やクエリ失敗時は全項目 OFF の安全な既定値を返す
 * (誤って自動化が有効になり人手承認ゲートが飛ばされることを防ぐ)。
 *
 * 仕様根拠: docs/05 (パイプライン自動化ゲート) — apps/web/lib/pipeline-settings-core.ts と対の存在。
 */
import { createLogger } from '@a2p/contracts/logger';

export interface PipelineAutopassFlags {
  autopass_theme_enabled: boolean;
  pipeline_themes_per_day: number;
  pipeline_theme_direction: string;
  pipeline_theme_cron: string;
  autopass_outline_enabled: boolean;
  autopass_content_enabled: boolean;
  autopass_cover_enabled: boolean;
  autopass_kdp_enabled: boolean;
}

/**
 * Prisma 部分 I/F — 呼び出し元 (各 pipeline task) の `appSettings.findUnique` を
 * そのまま渡せるよう、select/戻り値をゆるく型付けしている
 * (各 task は自身の目的に応じた select を同メソッドに対して複数回呼ぶことがあるため)。
 */
export interface PipelineAutopassPrisma {
  appSettings: {
    findUnique: (args: {
      where: { id: string };
      select: Record<string, boolean>;
    }) => Promise<Record<string, unknown> | null>;
  };
}

const SAFE_DEFAULT: PipelineAutopassFlags = {
  autopass_theme_enabled: false,
  pipeline_themes_per_day: 3,
  pipeline_theme_direction: '',
  pipeline_theme_cron: '0 22 * * *',
  autopass_outline_enabled: false,
  autopass_content_enabled: false,
  autopass_cover_enabled: false,
  autopass_kdp_enabled: false,
};

const log = createLogger('worker.pipeline-autopass');

/**
 * AppSettings(singleton) から autopass_* / pipeline_theme_* を読み出す。
 * 行が無い場合・クエリが失敗した場合は SAFE_DEFAULT (全 OFF) を返す。
 */
export async function readPipelineAutopass(
  prisma: PipelineAutopassPrisma,
): Promise<PipelineAutopassFlags> {
  try {
    const row = await prisma.appSettings.findUnique({
      where: { id: 'singleton' },
      select: {
        autopass_theme_enabled: true,
        pipeline_themes_per_day: true,
        pipeline_theme_direction: true,
        pipeline_theme_cron: true,
        autopass_outline_enabled: true,
        autopass_content_enabled: true,
        autopass_cover_enabled: true,
        autopass_kdp_enabled: true,
      },
    });
    if (!row) return { ...SAFE_DEFAULT };
    return {
      autopass_theme_enabled: Boolean(row.autopass_theme_enabled),
      pipeline_themes_per_day:
        typeof row.pipeline_themes_per_day === 'number'
          ? row.pipeline_themes_per_day
          : SAFE_DEFAULT.pipeline_themes_per_day,
      pipeline_theme_direction:
        typeof row.pipeline_theme_direction === 'string'
          ? row.pipeline_theme_direction
          : SAFE_DEFAULT.pipeline_theme_direction,
      pipeline_theme_cron:
        typeof row.pipeline_theme_cron === 'string' && row.pipeline_theme_cron.trim().length > 0
          ? row.pipeline_theme_cron
          : SAFE_DEFAULT.pipeline_theme_cron,
      autopass_outline_enabled: Boolean(row.autopass_outline_enabled),
      autopass_content_enabled: Boolean(row.autopass_content_enabled),
      autopass_cover_enabled: Boolean(row.autopass_cover_enabled),
      autopass_kdp_enabled: Boolean(row.autopass_kdp_enabled),
    };
  } catch (err) {
    log.warn(
      { err },
      'failed to read AppSettings for pipeline autopass — using safe defaults (all off)',
    );
    return { ...SAFE_DEFAULT };
  }
}
