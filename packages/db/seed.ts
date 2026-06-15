/**
 * packages/db/seed.ts
 *
 * 初期データ投入スクリプト (docs/05 §13 #9, SP-01 T-01-04)。
 *
 * 投入内容:
 *  1. AppSettings (id='singleton') — 既定値で 1 行
 *  2. Prompts — 役割 × ジャンルごとの v1 アクティブテンプレ
 *  3. ModelAssignments — docs/01 §7.3 初期推奨表
 *  4. User × 1（AUTH_USERNAME / AUTH_PASSWORD_HASH env から）
 *
 * 設計:
 *  - 全件 upsert で **idempotent**（複数回実行 OK）
 *  - 役割名は schema コメント (marketer/writer/editor/judge/thumbnail_text/
 *    thumbnail_image/optimizer) に整合
 *  - ジャンル名は ThemeCandidate.genre と同じ (practical/business/self_help)
 *  - 本ファイルは関数として export し、テスト/CLI の双方から利用可能
 *
 * 実行: `pnpm --filter @a2p/db seed`
 */
import type { PrismaClient } from './generated/index.js';

// ---------------------------------------------------------------------------
// 役割・ジャンル定義
// ---------------------------------------------------------------------------

export const PROMPT_ROLES = [
  'marketer',
  'marketer_plan',
  'writer',
  'editor',
  'thumbnail_text',
  'thumbnail_image',
  'judge',
  'optimizer',
] as const;
export type PromptRole = (typeof PROMPT_ROLES)[number];

export const PROMPT_GENRES = ['practical', 'business', 'self_help'] as const;
export type PromptGenre = (typeof PROMPT_GENRES)[number];

/**
 * Prompts に投入する全ジャンル軸 (3 ジャンル + null = 4 種)。
 * 全 7 役 × 4 ジャンル = 28 件を v1 active で投入する (SP-01 §3 / T-01-04)。
 *
 * `null` は「ジャンル横断既定」のフォールバック。Marketer/Judge/Optimizer は
 * 主に genre=null を参照するが、UI/Optimizer が将来ジャンル別に差し替える
 * 余地を残すため、Writer/Editor/Thumbnail も含めて全ジャンルに枠を確保する。
 */
export const PROMPT_GENRE_AXES = [
  ...PROMPT_GENRES,
  null,
] as const satisfies readonly (PromptGenre | null)[];

/**
 * ジャンル横断（genre = null）の枠を主に使う役割。
 * 互換のため定数として残す（外部 import 元あり）が、seed 投入は全ジャンル列挙する。
 * docs/01 §7.3 と F-027〜F-031 の整合。
 */
export const GENRE_AGNOSTIC_ROLES: ReadonlySet<PromptRole> = new Set([
  'marketer',
  'marketer_plan',
  'judge',
  'optimizer',
]);

// ---------------------------------------------------------------------------
// AppSettings 既定値
// ---------------------------------------------------------------------------

/**
 * AI 生成開示文（巻末挿入用）の初期文言。
 * NOTE: KDP の「AI Content」ポリシー最新版に合わせ、運営者が S-027 で
 *       更新する想定（docs/05 OQ-D-07 / docs/01 §7.1）。
 *       seed では仮文言で投入し、本番運用前に運営者が確認・差し替える。
 */
export const DEFAULT_AI_DISCLOSURE_TEXT =
  '本書の本文は生成 AI を活用して作成し、著者が編集・監修したコンテンツです。Amazon KDP のコンテンツガイドラインに従い、AI 生成コンテンツであることを明示します。';

export interface AppSettingsSeed {
  id: 'singleton';
  notification_email_to: string;
  notification_kinds_json: Record<string, boolean>;
  cost_per_book_warn_jpy: number;
  cost_per_book_pause_jpy: number;
  monthly_cost_yellow_jpy: number;
  monthly_cost_orange_jpy: number;
  monthly_cost_red_jpy: number;
  prompt_auto_approval_enabled: boolean;
  prompt_auto_approval_rollback_h: number;
  sales_auto_fetch_enabled: boolean;
  sales_auto_fetch_cron: string;
  kdp_submit_timeout_minutes: number;
  kdp_submit_retry_count: number;
  job_log_retention_days: number;
  ai_disclosure_text: string;
}

/**
 * AppSettings の seed 値を生成。env (MAIL_TO) 未設定でも seed を通すため、
 * 通知先メールは fallback を持つ（運営者は S-027 で本番値に更新する）。
 */
export function buildAppSettingsSeed(env: NodeJS.ProcessEnv): AppSettingsSeed {
  const mailTo = env.MAIL_TO ?? 'operator@example.invalid';
  return {
    id: 'singleton',
    notification_email_to: mailTo,
    notification_kinds_json: {
      cost_per_book_warn: true,
      cost_per_book_pause: true,
      monthly_cost_80: true,
      monthly_cost_95: true,
      monthly_cost_100: true,
      catalog_price_change: true,
      job_failed_3times: true,
      catalog_fetch_failed: true,
      fx_fetch_failed: true,
      revision_run_failed: true,
    },
    cost_per_book_warn_jpy: 500,
    cost_per_book_pause_jpy: 750,
    monthly_cost_yellow_jpy: 40000,
    monthly_cost_orange_jpy: 47500,
    monthly_cost_red_jpy: 50000,
    prompt_auto_approval_enabled: false,
    prompt_auto_approval_rollback_h: 24,
    sales_auto_fetch_enabled: false,
    sales_auto_fetch_cron: '0 17 * * *',
    kdp_submit_timeout_minutes: 10,
    kdp_submit_retry_count: 2,
    job_log_retention_days: 90,
    ai_disclosure_text: DEFAULT_AI_DISCLOSURE_TEXT,
  };
}

// ---------------------------------------------------------------------------
// Prompts 既定値
// ---------------------------------------------------------------------------

export interface PromptSeed {
  role: PromptRole;
  genre: PromptGenre | null;
  version: number;
  body: string;
  placeholders_json: string[];
  status: 'active';
  created_by: string;
}

/**
 * 最小限のプレースホルダ本文を生成。
 * 後続スプリント (SP-02〜SP-05) で実装側が本格的なテンプレートに置換する。
 * judge ロールのみ Hard Rule 4 に従い、6 軸採点を指示する本格日本語テンプレを投入する。
 */
function buildPromptBody(role: PromptRole, genre: PromptGenre | null): string {
  if (role === 'judge') {
    return buildJudgePromptBody(genre);
  }
  if (role === 'optimizer') {
    return buildOptimizerPromptBody(genre);
  }
  const genreLabel = genre ?? '(全ジャンル既定)';
  return [
    `# ${role} prompt (v1, ${genreLabel})`,
    '',
    'これは A2P 初期 seed のプレースホルダプロンプトです。',
    `後続スプリントで ${role} エージェントの本実装と共に置換されます。`,
    '',
    '## 入力',
    '- {input_summary}',
    '',
    '## 出力',
    `${role} の役割定義に従い、ジャンル「${genreLabel}」向けに最小限の応答を返してください。`,
  ].join('\n');
}

/**
 * Judge ロール専用の日本語採点プロンプトテンプレートを生成。
 * SP-10 §T-10-02 の 6 軸採点要件と docs/05 §6.3.5 の I/O 仕様に準拠。
 * プレースホルダは ROLE_PLACEHOLDERS['judge'] の 8 項目と一致させる。
 */
function buildJudgePromptBody(genre: PromptGenre | null): string {
  const genreLabel = genre ?? '全ジャンル';
  return `# Quality Judge プロンプト (v1, ${genreLabel})

あなたは Amazon KDP 向け日本語書籍の品質審査員です。
以下のテーマ情報・アウトライン・草稿を読み、6 軸で採点してください。

## テーマ情報

- タイトル: {theme_title}
- サブタイトル: {theme_subtitle}
- フック（訴求文）: {theme_hook}
- 想定読者: {target_reader}
- ジャンル: {genre}

## アウトライン概要

{outline_summary}

## 草稿（全 {chapter_count} 章）

{draft_chapters}

---

## 採点基準（6 軸、各 0〜100 点）

以下の 6 軸をそれぞれ 0〜100 の整数で採点してください。

1. **benefit_clarity（ベネフィット明確性）**
   読者が得られる具体的な価値・メリットが明確に述べられているか。
   抽象的・曖昧な説明が多い場合は減点。

2. **logical_consistency（論理的一貫性）**
   章間・節間の論旨が矛盾なく繋がっているか。
   根拠なき主張や飛躍がある場合は減点。

3. **style_consistency（文体の一貫性）**
   全章を通じて文体・語調・敬体/常体が統一されているか。
   混在・揺れがある場合は減点。

4. **japanese_naturalness（日本語の自然さ）**
   表現が不自然・不正確・機械的でないか。
   誤字・脱字・文法誤りがある場合は減点。

5. **title_alignment（タイトルとの整合性）**
   本文の内容がタイトル・サブタイトル・フックと合致しているか。
   タイトルが示す約束を本文が果たしていない場合は減点。

6. **genre_fit（ジャンル適合度）**
   ジャンル「${genreLabel}」の読者が期待する内容・構成・トーンに合致しているか。
   ジャンル外れの内容や構成がある場合は減点。

---

## 出力形式

以下の JSON を**コードブロックなし**で出力してください。それ以外のテキストは一切含めないこと。

{
  "score_total": <6 軸の均等平均（小数点以下切り捨て）>,
  "score_breakdown": {
    "benefit_clarity": <0-100の整数>,
    "logical_consistency": <0-100の整数>,
    "style_consistency": <0-100の整数>,
    "japanese_naturalness": <0-100の整数>,
    "title_alignment": <0-100の整数>,
    "genre_fit": <0-100の整数>
  },
  "judge_comments": {
    "benefit_clarity": "<採点根拠・改善提案（日本語）>",
    "logical_consistency": "<採点根拠・改善提案（日本語）>",
    "style_consistency": "<採点根拠・改善提案（日本語）>",
    "japanese_naturalness": "<採点根拠・改善提案（日本語）>",
    "title_alignment": "<採点根拠・改善提案（日本語）>",
    "genre_fit": "<採点根拠・改善提案（日本語）>",
    "overall": "<総評（日本語）>"
  }
}
`;
}

/**
 * Optimizer ロール専用の日本語プロンプト改訂テンプレートを生成。
 * SP-11 §T-11-01 の 6 プレースホルダ要件に準拠:
 * {role}/{genre}/{eval_count}/{current_prompt}/{eval_summary}/{sales_summary}
 * NOTE: プレースホルダは {key} 形式 (${...} は使わない — fillPlaceholders の仕様)。
 */
function buildOptimizerPromptBody(_genre: PromptGenre | null): string {
  return `# Prompt Optimizer プロンプト (v1)

あなたは Amazon KDP 向け日本語書籍生成システムの Prompt Optimizer エージェントです。
以下の情報を基に、指定エージェントのプロンプトを改訂してください。

## 改訂対象

- 対象役割: {role}
- 対象ジャンル: {genre}
- 評価件数: {eval_count} 件

## 現行プロンプト

{current_prompt}

## 直近の評価結果サマリ

{eval_summary}

## 直近の販売実績サマリ

{sales_summary}

---

## 改訂指針

1. 評価スコアが低い軸（50 点未満）を特定し、その軸を改善する具体的な指示をプロンプトに追加してください。
2. 販売実績（ロイヤリティ・レビュー評価）が低い場合は、読者ベネフィットをより明確に引き出す指示を追加してください。
3. 既存の良い部分（スコアが高い軸）は維持し、不要な変更を避けてください。
4. 改訂後のプロンプトは日本語で、構造化された形式（見出し・箇条書き）で記述してください。
5. 出力例 (sample_output) を提供して、改訂後プロンプトの効果を具体的に示してください（任意）。

## 出力形式

以下の JSON を**コードブロックなし**で出力してください。それ以外のテキストは一切含めないこと。

{
  "proposed_body": "<改訂後のプロンプト全文（改行は \\n でエスケープ）>",
  "diff": "<unified diff 形式の変更差分（改行は \\n でエスケープ）>",
  "rationale": "<改訂理由（日本語）>",
  "expected_effect": {
    "score_delta": <期待スコア改善量（省略可）>,
    "sales_delta_pct": <期待売上改善率（省略可）>
  },
  "sample_output": "<改訂後プロンプトを使った場合の出力例（省略可）>"
}
`;
}

const ROLE_PLACEHOLDERS: Record<PromptRole, string[]> = {
  marketer: ['account_brief', 'genre_policy', 'competitor_signals'],
  marketer_plan: ['months', 'target_count', 'published_books', 'sales_trend'],
  writer: ['outline', 'chapter_index', 'target_chars'],
  editor: ['draft_chapters', 'ai_disclosure_text'],
  thumbnail_text: ['title', 'subtitle', 'target_reader'],
  thumbnail_image: ['cover_text', 'style_hint'],
  judge: [
    'theme_title',
    'theme_subtitle',
    'theme_hook',
    'target_reader',
    'genre',
    'chapter_count',
    'draft_chapters',
    'outline_summary',
  ],
  optimizer: ['role', 'genre', 'eval_count', 'current_prompt', 'eval_summary', 'sales_summary'],
};

export function buildPromptSeeds(): PromptSeed[] {
  const seeds: PromptSeed[] = [];
  for (const role of PROMPT_ROLES) {
    for (const genre of PROMPT_GENRE_AXES) {
      seeds.push({
        role,
        genre,
        version: 1,
        body: buildPromptBody(role, genre),
        placeholders_json: ROLE_PLACEHOLDERS[role],
        status: 'active',
        created_by: 'system',
      });
    }
  }
  return seeds;
}

// ---------------------------------------------------------------------------
// ModelAssignments 既定値 (docs/01 §7.3)
// ---------------------------------------------------------------------------

export interface ModelAssignmentSeed {
  role: PromptRole;
  genre: null;
  provider: 'anthropic' | 'openai' | 'google';
  model: string;
  status: 'active';
  created_by: string;
}

export function buildModelAssignmentSeeds(): ModelAssignmentSeed[] {
  return [
    { role: 'marketer', genre: null, provider: 'anthropic', model: 'claude-opus-4-7', status: 'active', created_by: 'system' },
    { role: 'marketer_plan', genre: null, provider: 'anthropic', model: 'claude-opus-4-7', status: 'active', created_by: 'system' },
    { role: 'writer', genre: null, provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'active', created_by: 'system' },
    { role: 'editor', genre: null, provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'active', created_by: 'system' },
    { role: 'judge', genre: null, provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'active', created_by: 'system' },
    { role: 'optimizer', genre: null, provider: 'anthropic', model: 'claude-opus-4-7', status: 'active', created_by: 'system' },
    { role: 'thumbnail_text', genre: null, provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'active', created_by: 'system' },
    { role: 'thumbnail_image', genre: null, provider: 'openai', model: 'gpt-image-1', status: 'active', created_by: 'system' },
  ];
}

// ---------------------------------------------------------------------------
// User 既定値 (env から)
// ---------------------------------------------------------------------------

export interface UserSeed {
  username: string;
  password_hash: string;
}

export function buildUserSeed(env: NodeJS.ProcessEnv): UserSeed | null {
  const username = env.AUTH_USERNAME;
  const passwordHash = env.AUTH_PASSWORD_HASH;
  if (!username || !passwordHash) return null;
  return { username, password_hash: passwordHash };
}

// ---------------------------------------------------------------------------
// 実行ロジック
// ---------------------------------------------------------------------------

export interface SeedResult {
  appSettings: 1;
  prompts: number;
  modelAssignments: number;
  user: 0 | 1;
}

export interface SeedLogger {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
}

const consoleLogger: SeedLogger = {
  // WHY: seed は CLI 経由で stdout に進捗を出したい
  info: (msg, meta) => {
    if (meta !== undefined) console.log(`[seed] ${msg}`, meta);
    else console.log(`[seed] ${msg}`);
  },
  warn: (msg, meta) => {
    if (meta !== undefined) console.warn(`[seed] WARN ${msg}`, meta);
    else console.warn(`[seed] WARN ${msg}`);
  },
};

/**
 * Seed 実行関数。`prisma` クライアントと `env` を受け取り、全データを upsert する。
 * テストでは prisma を mock したクライアントで呼び出せる。
 */
export async function runSeed(
  prisma: Pick<PrismaClient, 'appSettings' | 'prompt' | 'modelAssignment' | 'user'>,
  env: NodeJS.ProcessEnv = process.env,
  logger: SeedLogger = consoleLogger,
): Promise<SeedResult> {
  // 1. AppSettings (singleton)
  const settings = buildAppSettingsSeed(env);
  await prisma.appSettings.upsert({
    where: { id: settings.id },
    create: settings,
    update: {
      // 既に運営者が S-027 で書き換えている可能性がある項目は触らない。
      // seed 再実行で必ず再設定すべき構造的フィールドのみ更新。
      notification_kinds_json: settings.notification_kinds_json,
    },
  });
  logger.info('AppSettings upserted (singleton)');

  // 2. Prompts (役割 × ジャンル)
  // Prisma の compound unique key は nullable フィールド (genre) を許容しないため、
  // findFirst + create/update で idempotent を確保。
  const promptSeeds = buildPromptSeeds();
  for (const seed of promptSeeds) {
    const existing = await prisma.prompt.findFirst({
      where: { role: seed.role, genre: seed.genre, version: seed.version },
    });
    if (existing) {
      await prisma.prompt.update({
        where: { id: existing.id },
        data: {
          // 既に運営者/Optimizer が本文を差し替えている可能性があるため、
          // 本文・状態は触らず system 印のみ維持する。
          created_by: seed.created_by,
        },
      });
    } else {
      await prisma.prompt.create({
        data: {
          role: seed.role,
          genre: seed.genre,
          version: seed.version,
          body: seed.body,
          placeholders_json: seed.placeholders_json,
          status: seed.status,
          created_by: seed.created_by,
          activated_at: new Date(),
        },
      });
    }
  }
  logger.info(`Prompts ensured (${promptSeeds.length} rows)`);

  // 3. ModelAssignments
  const assignmentSeeds = buildModelAssignmentSeeds();
  for (const seed of assignmentSeeds) {
    // ModelAssignment には自然キーがないため、(role, genre, status='active') を
    // 業務上のキーとみなして findFirst → create/update。
    const existing = await prisma.modelAssignment.findFirst({
      where: { role: seed.role, genre: seed.genre, status: 'active' },
    });
    if (existing) {
      await prisma.modelAssignment.update({
        where: { id: existing.id },
        data: {
          // 運営者が UI から差し替えた可能性があるため provider/model は触らない。
          // active 状態のみ維持。
          status: 'active',
        },
      });
    } else {
      await prisma.modelAssignment.create({
        data: {
          role: seed.role,
          genre: seed.genre,
          provider: seed.provider,
          model: seed.model,
          status: seed.status,
          created_by: seed.created_by,
        },
      });
    }
  }
  logger.info(`ModelAssignments ensured (${assignmentSeeds.length} rows)`);

  // 4. User (env から)
  const userSeed = buildUserSeed(env);
  let userInserted: 0 | 1 = 0;
  if (userSeed) {
    await prisma.user.upsert({
      where: { username: userSeed.username },
      create: {
        username: userSeed.username,
        password_hash: userSeed.password_hash,
      },
      update: {
        password_hash: userSeed.password_hash,
      },
    });
    userInserted = 1;
    logger.info(`User upserted (${userSeed.username})`);
  } else {
    logger.warn(
      'User skipped: AUTH_USERNAME / AUTH_PASSWORD_HASH が未設定のため。' +
        ' ローカル開発では `.env.local` に bcrypt ハッシュを設定してから再実行してください。',
    );
  }

  return {
    appSettings: 1,
    prompts: promptSeeds.length,
    modelAssignments: assignmentSeeds.length,
    user: userInserted,
  };
}

// ---------------------------------------------------------------------------
// CLI エントリポイント
// ---------------------------------------------------------------------------

// `tsx packages/db/seed.ts` で直接実行されたときのみ DB に接続する。
// import * as seed from './seed.js' の経路では副作用を起こさない。
async function isDirectRun(): Promise<boolean> {
  if (typeof process === 'undefined' || process.argv[1] === undefined) return false;
  const { fileURLToPath } = await import('node:url');
  try {
    return process.argv[1] === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (await isDirectRun()) {
  // Top-level await を避けるため即時関数で wrap。
  (async () => {
    const { prisma } = await import('./index.js');
    try {
      const result = await runSeed(prisma, process.env);
      console.log('[seed] DONE', result);
    } catch (err) {
      console.error('[seed] FAILED', err);
      process.exitCode = 1;
    } finally {
      await prisma.$disconnect();
    }
  })();
}
