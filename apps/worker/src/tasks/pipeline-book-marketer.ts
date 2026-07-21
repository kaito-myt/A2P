import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import {
  acquireBookLock as defaultAcquireBookLock,
  releaseBookLock as defaultReleaseBookLock,
} from '@a2p/agents/lib/book-lock';
import { generateMarketerMetadata as defaultGenerateMarketerMetadata } from '@a2p/agents/marketer';
import type { MarketerMetadataInput } from '@a2p/contracts/agents/marketer';
import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

import { ALERT_COST_CHECK_TASK_NAME } from './alert-cost-check.js';

/**
 * `pipeline.book.marketer` タスク (docs/05 §5.3.2, F-001/F-040)
 *
 * テーマ採用済みの `Book` に対し、Marketer エージェントで KDP メタデータ
 * (description/categories/keywords/price) を生成し `KdpMetadata` に保存する。
 * 完了で `pipeline.book.writer.outline` を子 enqueue する。
 *
 * フロー (docs/05 §5.2 共通ポリシー + §13 #5 冪等性):
 *   1. payload zod parse (book_id / job_id)
 *   2. 内部 `Job` 行を CAS で `running` に更新。既に `done` ならスキップ (idempotency)。
 *   3. `acquireBookLock(book_id, 'pipeline:<job_id>', 30)` — 衝突は ConflictError として throw
 *      (graphile-worker のリトライに任せる)。
 *   4. `Book` + 関連 `ThemeCandidate` を読み出し、genre / themeContext を組み立てる。
 *   5. `generateMarketerMetadata(...)` 呼出。jobId は内部 `Job.id` (cuid) を渡す
 *      (T-03-01/02 教訓: token_usage.job_id は内部 Job.id 専用)。
 *   6. `KdpMetadata.upsert` で INSERT or 更新 (再実行で重複しない)。
 *   7. 内部 `Job.status='done'`, `finished_at=now()` に遷移。
 *   8. `pipeline.book.writer.outline` 用の **内部 `Job` 行を新規 INSERT** し
 *      (`kind`/`book_id`/`parent_job_id=<marketer jobId>`/`status='queued'`)、
 *      その新規 Job.id を payload に乗せて graphile-worker へ enqueue。
 *   9. finally で BookLock 解放。
 *
 * エラー方針:
 *   - 入力 payload 不正 → `ValidationError` を throw (graphile-worker は retry するが、
 *     payload は不変なので 3 回連続で failed → 永続失敗)。
 *   - Book / Theme 不在 → `NotFoundError` を throw (同上)。
 *   - LLM/Provider 透過エラー / DB エラー → そのまま throw。graphile-worker が
 *     `max_attempts=3` で再試行する。
 *   - 内部 `Job` を `running` に上げた後の失敗は `failed` に降格 (next attempt で
 *     再度 `queued`→`running` できるよう状態は元に戻す)。
 */

export const PIPELINE_BOOK_MARKETER_TASK_NAME = 'pipeline.book.marketer';

/** docs/05 §5.3.2: `{ book_id, job_id }`。 */
export const PipelineBookMarketerPayloadSchema = z.object({
  book_id: z.string().min(1),
  job_id: z.string().min(1),
});
export type PipelineBookMarketerPayload = z.infer<typeof PipelineBookMarketerPayloadSchema>;

/** Prisma 部分 I/F — テストで mock しやすいよう最小サブセット。 */
export interface PipelineBookMarketerPrisma {
  job: {
    findUnique: (args: {
      where: { id: string };
      select: { status: true; book_id: true };
    }) => Promise<{ status: string; book_id: string | null } | null>;
    updateMany: (args: {
      where: { id: string; status: { in: string[] } };
      data: { status: string; started_at?: Date };
    }) => Promise<{ count: number }>;
    update: (args: {
      where: { id: string };
      data: {
        status?: string;
        finished_at?: Date;
        error?: string | null;
        result_json?: unknown;
      };
    }) => Promise<unknown>;
    create: (args: {
      data: {
        kind: string;
        book_id: string;
        parent_job_id: string;
        status: string;
        payload_json: unknown;
      };
    }) => Promise<{ id: string }>;
  };
  book: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        account_id: true;
        theme_id: true;
        title: true;
        subtitle: true;
      };
    }) => Promise<{
      id: string;
      account_id: string;
      theme_id: string | null;
      title: string;
      subtitle: string | null;
    } | null>;
  };
  themeCandidate: {
    findUnique: (args: {
      where: { id: string };
      select: {
        id: true;
        genre: true;
        title: true;
        subtitle: true;
        hook: true;
        target_reader: true;
        competitors_json: true;
        signals_json: true;
      };
    }) => Promise<{
      id: string;
      genre: string;
      title: string;
      subtitle: string | null;
      hook: string;
      target_reader: string | null;
      competitors_json: unknown;
      signals_json: unknown;
    } | null>;
  };
  kdpMetadata: {
    upsert: (args: {
      where: { book_id: string };
      create: {
        book_id: string;
        description: string;
        categories: string[];
        keywords: string[];
        price_jpy: number;
      };
      update: {
        description: string;
        categories: string[];
        keywords: string[];
        price_jpy: number;
      };
    }) => Promise<{ id: string; book_id: string }>;
  };
}

/** `helpers.addJob` の最小 I/F — テスト時は mock を差し込む。 */
export type AddJobLike = (
  identifier: string,
  payload: unknown,
  spec?: Record<string, unknown>,
) => Promise<unknown>;

export interface PipelineBookMarketerDeps {
  prisma?: PipelineBookMarketerPrisma;
  logger?: Logger;
  generateMetadata?: typeof defaultGenerateMarketerMetadata;
  acquireLock?: typeof defaultAcquireBookLock;
  releaseLock?: typeof defaultReleaseBookLock;
  now?: () => Date;
}

const ALLOWED_GENRES = new Set(['practical', 'business', 'self_help']);

/**
 * graphile-worker から呼ばれる Task 本体は下の `pipelineBookMarketerTask`。
 * このヘルパは DI を受け取りテストから直接呼べる。
 */
export async function runPipelineBookMarketer(
  payload: unknown,
  addJob: AddJobLike,
  deps: PipelineBookMarketerDeps = {},
): Promise<void> {
  const parsed = PipelineBookMarketerPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('pipeline.book.marketer payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const { book_id: bookId, job_id: jobId } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PIPELINE_BOOK_MARKETER_TASK_NAME}`);
  const prisma =
    deps.prisma ?? (defaultPrisma as unknown as PipelineBookMarketerPrisma);
  const generateMetadata = deps.generateMetadata ?? defaultGenerateMarketerMetadata;
  const acquireLock = deps.acquireLock ?? defaultAcquireBookLock;
  const releaseLock = deps.releaseLock ?? defaultReleaseBookLock;
  const now = deps.now ?? (() => new Date());

  // 1. 冪等性チェック: 既に done なら skip (docs/05 §13 #5)
  const existing = await prisma.job.findUnique({
    where: { id: jobId },
    select: { status: true, book_id: true },
  });
  if (!existing) {
    throw new NotFoundError(`Job not found: ${jobId}`, {
      details: { jobId, bookId },
    });
  }
  if (existing.status === 'done') {
    log.info(
      { task: PIPELINE_BOOK_MARKETER_TASK_NAME, jobId, bookId },
      'job already done — skipping (idempotent)',
    );
    return;
  }

  // 2. CAS で queued/failed → running。レースで他 worker が先に running 化していたら skip。
  //    failed からの再試行 (graphile-worker のリトライ) も許容するため status: in [queued, failed]。
  const casResult = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ['queued', 'failed'] } },
    data: { status: 'running', started_at: now() },
  });
  if (casResult.count === 0) {
    log.info(
      { task: PIPELINE_BOOK_MARKETER_TASK_NAME, jobId, bookId, observedStatus: existing.status },
      'job not in queued/failed state — skipping (probably already running on another worker)',
    );
    return;
  }

  // 3. BookLock 取得 (holder = pipeline:<job_id>, TTL 30 分)
  //    取得自体が失敗した場合は Job を failed に戻して throw (graphile-worker が retry)。
  try {
    await acquireLock({
      bookId,
      holder: `pipeline:${jobId}`,
      ttlMinutes: 30,
    });
  } catch (lockErr) {
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          finished_at: now(),
          error: serializeError(lockErr),
        },
      });
    } catch (jobUpdateErr) {
      log.warn(
        { task: PIPELINE_BOOK_MARKETER_TASK_NAME, jobId, bookId, err: jobUpdateErr },
        'failed to mark internal Job as failed after lock acquire failure',
      );
    }
    throw lockErr;
  }

  try {
    // 4. Book + Theme 取得
    const book = await prisma.book.findUnique({
      where: { id: bookId },
      select: {
        id: true,
        account_id: true,
        theme_id: true,
        title: true,
        subtitle: true,
      },
    });
    if (!book) {
      throw new NotFoundError(`Book not found: ${bookId}`, {
        details: { bookId, jobId },
      });
    }
    if (!book.theme_id) {
      throw new NotFoundError(`Book has no theme_id: ${bookId}`, {
        details: { bookId, jobId },
      });
    }

    const theme = await prisma.themeCandidate.findUnique({
      where: { id: book.theme_id },
      select: {
        id: true,
        genre: true,
        title: true,
        subtitle: true,
        hook: true,
        target_reader: true,
        competitors_json: true,
        signals_json: true,
      },
    });
    if (!theme) {
      throw new NotFoundError(`ThemeCandidate not found: ${book.theme_id}`, {
        details: { themeId: book.theme_id, bookId, jobId },
      });
    }

    // 5. themeContext を組み立て → generateMarketerMetadata
    //    NOTE: 採用 theme の精査 (再 validate / refine) は本タスク範囲外。
    //          既に accepted 済みの theme をそのまま使う (SP-03 §4 T-03-04 task spec)。
    const themeContext = buildThemeContext(book, theme);
    const genre = normalizeGenre(theme.genre);

    const metadataInput: MarketerMetadataInput = {
      jobId,
      bookId,
      accountId: book.account_id,
      genre,
      themeContext,
    };

    const result = await generateMetadata(metadataInput);

    // 6. KdpMetadata upsert (book_id is @unique → 再実行で重複しない)
    const upserted = await prisma.kdpMetadata.upsert({
      where: { book_id: bookId },
      create: {
        book_id: bookId,
        description: result.metadata.description,
        categories: result.metadata.categories,
        keywords: result.metadata.keywords,
        price_jpy: result.metadata.suggested_price_jpy,
      },
      update: {
        description: result.metadata.description,
        categories: result.metadata.categories,
        keywords: result.metadata.keywords,
        price_jpy: result.metadata.suggested_price_jpy,
      },
    });

    // 7. Job を done に遷移
    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'done',
        finished_at: now(),
        error: null,
        result_json: {
          kdp_metadata_id: upserted.id,
          notes: result.notes ?? null,
        },
      },
    });

    log.info(
      {
        task: PIPELINE_BOOK_MARKETER_TASK_NAME,
        jobId,
        bookId,
        kdpMetadataId: upserted.id,
        keywordCount: result.metadata.keywords.length,
        priceJpy: result.metadata.suggested_price_jpy,
      },
      'pipeline.book.marketer done — KdpMetadata upserted',
    );

    // 8a. per_book コストチェック enqueue (F-034 / T-07-02)
    await addJob(
      ALERT_COST_CHECK_TASK_NAME,
      { scope: 'per_book', book_id: bookId },
    );

    // 8a-2. フリガナ(readings)を自動生成: KdpMetadata が出来た直後に連鎖させ、
    //       KDP 入稿チェックリストを開いた時点でフリガナが「最初から」揃うようにする。
    //       非致命 (失敗しても本編パイプラインは止めない)。
    try {
      const readingsJob = await prisma.job.create({
        data: {
          kind: 'pipeline.book.readings.generate',
          book_id: bookId,
          parent_job_id: jobId,
          status: 'queued',
          payload_json: { book_id: bookId },
        },
      });
      await addJob(
        'pipeline.book.readings.generate',
        { book_id: bookId, job_id: readingsJob.id },
        { maxAttempts: 3 },
      );
    } catch (readingsErr) {
      log.warn(
        { task: PIPELINE_BOOK_MARKETER_TASK_NAME, jobId, bookId, err: readingsErr },
        'failed to enqueue readings — non-fatal',
      );
    }

    // 8. 内部 Job 行を新規作成し、その id を payload に乗せて graphile-worker へ enqueue
    //    payload は docs/05 §5.3.3 準拠の `{ book_id, job_id }`。
    //    `job_id` は **新規作成した子 Job の id** (= 親 marketer jobId ではない)。
    const childPayload = { book_id: bookId } as const;
    const childJob = await prisma.job.create({
      data: {
        kind: 'pipeline.book.writer.outline',
        book_id: bookId,
        parent_job_id: jobId,
        status: 'queued',
        payload_json: childPayload,
      },
    });
    await addJob(
      'pipeline.book.writer.outline',
      { book_id: bookId, job_id: childJob.id },
      { maxAttempts: 3 },
    );
  } catch (err) {
    // Job を failed に降格 (次回 attempt で再 CAS できるよう、エラー文を残す)
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'failed',
          finished_at: now(),
          error: serializeError(err),
        },
      });
    } catch (jobUpdateErr) {
      log.warn(
        { task: PIPELINE_BOOK_MARKETER_TASK_NAME, jobId, bookId, err: jobUpdateErr },
        'failed to mark internal Job as failed',
      );
    }
    throw err;
  } finally {
    try {
      await releaseLock({ bookId, holder: `pipeline:${jobId}` });
    } catch (releaseErr) {
      log.warn(
        { task: PIPELINE_BOOK_MARKETER_TASK_NAME, jobId, bookId, err: releaseErr },
        'failed to release BookLock (will be swept by locks.sweep)',
      );
    }
  }
}

/** competitors_json (unknown[]) と signals_json (unknown) を Marketer 入力形状に整える。 */
function buildThemeContext(
  book: { title: string; subtitle: string | null },
  theme: {
    title: string;
    subtitle: string | null;
    hook: string;
    target_reader: string | null;
    competitors_json: unknown;
    signals_json: unknown;
  },
): MarketerMetadataInput['themeContext'] {
  const competitors = Array.isArray(theme.competitors_json)
    ? (theme.competitors_json as unknown[]).slice(0, 50)
    : [];
  const ctx: MarketerMetadataInput['themeContext'] = {
    // Book.title を優先 (確定書籍タイトル)、未設定なら theme.title
    title: (book.title && book.title.length > 0 ? book.title : theme.title).slice(0, 200),
    hook: (theme.hook ?? '').slice(0, 800) || '(no hook)',
    target_reader: (theme.target_reader ?? '').slice(0, 300) || '(no target_reader)',
    competitors,
  };
  const subtitle = book.subtitle ?? theme.subtitle ?? null;
  if (subtitle && subtitle.length > 0) {
    ctx.subtitle = subtitle.slice(0, 200);
  }
  if (theme.signals_json !== undefined && theme.signals_json !== null) {
    ctx.signals = theme.signals_json;
  }
  return ctx;
}

/** DB の genre 文字列を Marketer 入力 enum に正規化 (未知値は null fallback)。 */
function normalizeGenre(g: string): 'practical' | 'business' | 'self_help' | null {
  return ALLOWED_GENRES.has(g)
    ? (g as 'practical' | 'business' | 'self_help')
    : null;
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** graphile-worker 用エクスポート。`buildTaskList()` から登録される。 */
export const pipelineBookMarketerTask: Task = async (
  payload: unknown,
  helpers: JobHelpers,
) => {
  await runPipelineBookMarketer(
    payload,
    helpers.addJob as unknown as AddJobLike,
  );
};
