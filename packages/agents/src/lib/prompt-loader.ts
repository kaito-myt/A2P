/**
 * docs/05 §6.3 / F-027 — `prompts` テーブルから active 版のシステムプロンプトを取得し、
 * `{key}` 形式のプレースホルダを実行時値に差し込む。
 *
 * 解決順 (load-model-assignment.ts と同じフォールバック規約):
 *   1. role + genre (指定値) + status='active' に一致する最新 version
 *   2. role + genre = NULL (全ジャンル既定) + status='active' に一致する最新 version
 *   3. どちらも無ければ `ConfigError`
 *
 * WHY `nulls: 'last'` を必ず明示する:
 *   PostgreSQL の `ORDER BY ... DESC` 既定は **NULLS FIRST**。
 *   `orderBy: { genre: 'desc' }` だけでは genre=NULL 行が先頭に並び、
 *   genre 指定値が常に無視されるバグになる (F-027 受入基準違反)。
 *   よって `orderBy: [{ genre: { sort: 'desc', nulls: 'last' } }, { version: 'desc' }]`
 *   と NULLS LAST を明示し、指定値 (非 null) → null fallback の順を保証する。
 */
import { ConfigError } from '@a2p/contracts/errors';
import type { AgentRole, Genre } from '@a2p/contracts/agents';
import { genreGuidance, genreLabel } from '@a2p/contracts/agents';
import { prisma as defaultPrisma } from '@a2p/db';

export interface LoadedPrompt {
  /** プロンプト本文 (`{placeholder}` 含む未差込テンプレ)。 */
  template: string;
  /** 解決された version。 */
  version: number;
  /** 解決された Prompt レコード ID — token_usage 紐付け等に使える。 */
  promptId: string;
  /** 解決に使われた genre (null = 全ジャンル既定 fallback)。 */
  genre: Genre | null;
}

type SortOrder = 'asc' | 'desc';
type NullsOrder = 'first' | 'last';
type OrderBySpec = SortOrder | { sort: SortOrder; nulls?: NullsOrder };

interface PromptRepo {
  findFirst(args: {
    where: {
      role: string;
      status: string;
      OR: Array<{ genre: string | null }>;
    };
    orderBy: Array<{ genre: OrderBySpec } | { version: OrderBySpec }>;
    select?: {
      id?: true;
      body?: true;
      version?: true;
      genre?: true;
    };
  }): Promise<{
    id: string;
    body: string;
    version: number;
    genre: string | null;
  } | null>;
}

export interface PromptLoaderLogger {
  warn: (msg: string, meta?: unknown) => void;
}

export interface PromptLoaderDeps {
  prisma?: { prompt: PromptRepo };
  logger?: PromptLoaderLogger;
}

const defaultLogger: PromptLoaderLogger = {
  // WHY: 既定では未差込プレースホルダ検知だけを stderr に出す。本番では構造化ロガーへ差し替える。
  warn: (msg, meta) => {
    if (meta !== undefined) console.warn(`[prompt-loader] ${msg}`, meta);
    else console.warn(`[prompt-loader] ${msg}`);
  },
};

export async function loadActivePrompt(
  role: AgentRole,
  genre: Genre | null,
  deps: PromptLoaderDeps = {},
): Promise<LoadedPrompt> {
  const repo =
    deps.prisma?.prompt ??
    (defaultPrisma as unknown as { prompt: PromptRepo }).prompt;

  const row = await repo.findFirst({
    where: {
      role,
      status: 'active',
      OR: [{ genre }, { genre: null }],
    },
    // WHY: PostgreSQL DESC 既定は NULLS FIRST。NULLS LAST を明示しないと
    // genre=null 行が先頭に並び、genre 指定値が常に無視されるバグになる。
    orderBy: [{ genre: { sort: 'desc', nulls: 'last' } }, { version: 'desc' }],
    select: { id: true, body: true, version: true, genre: true },
  });

  if (!row) {
    throw new ConfigError(
      `no active Prompt for role=${role} genre=${genre ?? 'null'}`,
      {
        userMessage: `${role} のプロンプトテンプレートが見つかりません。設定画面から登録してください`,
      },
    );
  }

  return {
    // ジャンル方針は本文には焼き込まず、ここで実行時に注入する (genres.ts が単一の真実源)。
    // これにより「役割プロンプト 1 本」で全 29 ジャンルに対応でき、ジャンル別プロンプトの
    // 量産・手管理が不要になる。要求 genre に対応する方針を差し込む (null=汎用)。
    template: injectGenreTokens(row.body, genre),
    version: row.version,
    promptId: row.id,
    genre: (row.genre as Genre | null) ?? null,
  };
}

/**
 * プロンプト本文中の `{genre_guidance}` / `{genre_label}` を、要求 genre の値で置換する。
 * トークンが無い本文には無害 (置換なし)。fillPlaceholders より前に処理するため、
 * 各エージェントの placeholder 差込では未充填警告が出ない。
 */
export function injectGenreTokens(body: string, genre: Genre | null): string {
  if (!body.includes('{genre_guidance}') && !body.includes('{genre_label}')) {
    return body;
  }
  return body
    .replace(/\{genre_guidance\}/g, genreGuidance(genre))
    .replace(/\{genre_label\}/g, genreLabel(genre) ?? '汎用');
}

// ---------------------------------------------------------------------------
// プレースホルダ差込
// ---------------------------------------------------------------------------

/**
 * `{key}` 形式のプレースホルダを `data` の値で置換する。
 *
 * - 1 パス置換のみ (ネスト/再帰展開なし — data 値中の `{xxx}` は再評価しない)
 * - 同一 key が複数回出現したら全て置換
 * - data に存在しない key はそのまま残し、warn ログを出す
 *   (運用継続を優先。テンプレ側のミス検知は CI / 運用側で別途。)
 * - 値の型は string | number | boolean を許容し、内部で `String(v)` で stringify
 * - 値中の `{` `}` は escape しない (placeholder 値はそのまま注入)
 */
export function fillPlaceholders(
  template: string,
  data: Record<string, string | number | boolean>,
  deps: { logger?: PromptLoaderLogger } = {},
): string {
  if (template === '') return '';
  const logger = deps.logger ?? defaultLogger;
  const missing = new Set<string>();

  // `{key}` の key は英数+_-. 程度に制限 (誤マッチ防止)。
  const result = template.replace(/\{([A-Za-z0-9_\-.]+)\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      return String(data[key]);
    }
    missing.add(key);
    return match;
  });

  if (missing.size > 0) {
    logger.warn('unfilled placeholders', { keys: Array.from(missing) });
  }
  return result;
}
