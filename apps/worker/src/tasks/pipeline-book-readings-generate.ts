import type { JobHelpers, Task } from 'graphile-worker';
import { z } from 'zod';

import { generateReadings as defaultGenerateReadings, type GenerateReadingsDeps, type ReadingsResult } from '@a2p/agents';
import type { ReadingsInput } from '@a2p/contracts/agents/readings';
import { NotFoundError, ValidationError } from '@a2p/contracts/errors';
import { createLogger, type Logger } from '@a2p/contracts/logger';
import { prisma as defaultPrisma } from '@a2p/db';

/**
 * `pipeline.book.readings.generate` タスク (F-020b)
 *
 * タイトル/サブタイトル/著者名のカタカナ読み (フリガナ) を AI 生成し、
 * ローマ字を決定的変換して KdpMetadata に保存する。KDP 入稿チェックリストの
 * フリガナ/ローマ字コピー項目に使う。KdpMetadata が無い書籍はスキップ。
 */

export const PIPELINE_BOOK_READINGS_GENERATE_TASK_NAME = 'pipeline.book.readings.generate';

export const PipelineBookReadingsGeneratePayloadSchema = z.object({
  book_id: z.string().min(1),
  job_id: z.string().min(1),
});

export interface PipelineBookReadingsGeneratePrisma {
  job: {
    findUnique: (args: { where: { id: string }; select: { status: true } }) => Promise<{ status: string } | null>;
    updateMany: (args: {
      where: { id: string; status: { in: string[] } };
      data: { status: string; started_at?: Date };
    }) => Promise<{ count: number }>;
    update: (args: {
      where: { id: string };
      data: { status?: string; finished_at?: Date; error?: string | null; result_json?: unknown };
    }) => Promise<unknown>;
  };
  book: {
    findUnique: (args: {
      where: { id: string };
      select: { id: true; title: true; subtitle: true; account: { select: { pen_name: true } }; kdpMetadata: { select: { id: true } } };
    }) => Promise<{
      id: string;
      title: string;
      subtitle: string | null;
      account: { pen_name: string };
      kdpMetadata: { id: string } | null;
    } | null>;
  };
  kdpMetadata: {
    update: (args: { where: { book_id: string }; data: Record<string, string> }) => Promise<unknown>;
  };
}

export type AddJobLike = (identifier: string, payload: unknown, spec?: Record<string, unknown>) => Promise<unknown>;

export interface PipelineBookReadingsGenerateDeps {
  prisma?: PipelineBookReadingsGeneratePrisma;
  logger?: Logger;
  generateReadings?: (input: ReadingsInput, deps?: GenerateReadingsDeps) => Promise<ReadingsResult>;
  now?: () => Date;
}

export async function runPipelineBookReadingsGenerate(
  payload: unknown,
  _addJob: AddJobLike,
  deps: PipelineBookReadingsGenerateDeps = {},
): Promise<void> {
  const parsed = PipelineBookReadingsGeneratePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError('pipeline.book.readings.generate payload が不正です', {
      details: { issues: parsed.error.issues },
    });
  }
  const { book_id: bookId, job_id: jobId } = parsed.data;

  const log = deps.logger ?? createLogger(`worker.${PIPELINE_BOOK_READINGS_GENERATE_TASK_NAME}`);
  const prisma = deps.prisma ?? (defaultPrisma as unknown as PipelineBookReadingsGeneratePrisma);
  const generate = deps.generateReadings ?? defaultGenerateReadings;
  const now = deps.now ?? (() => new Date());

  const existing = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
  if (!existing) throw new NotFoundError(`Job not found: ${jobId}`, { details: { jobId, bookId } });
  if (existing.status === 'done') {
    log.info({ task: PIPELINE_BOOK_READINGS_GENERATE_TASK_NAME, jobId, bookId }, 'already done — skip');
    return;
  }
  const cas = await prisma.job.updateMany({
    where: { id: jobId, status: { in: ['queued', 'failed'] } },
    data: { status: 'running', started_at: now() },
  });
  if (cas.count === 0) {
    log.info({ task: PIPELINE_BOOK_READINGS_GENERATE_TASK_NAME, jobId, bookId }, 'not queued/failed — skip');
    return;
  }

  try {
    const book = await prisma.book.findUnique({
      where: { id: bookId },
      select: {
        id: true,
        title: true,
        subtitle: true,
        account: { select: { pen_name: true } },
        kdpMetadata: { select: { id: true } },
      },
    });
    if (!book) throw new NotFoundError(`Book not found: ${bookId}`, { details: { bookId, jobId } });
    if (!book.kdpMetadata) {
      // メタデータ未生成なら読みも保存先が無いのでスキップ (done 扱い)。
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'done', finished_at: now(), error: null, result_json: { skipped: 'no_metadata' } },
      });
      log.info({ task: PIPELINE_BOOK_READINGS_GENERATE_TASK_NAME, jobId, bookId }, 'no KdpMetadata — skip');
      return;
    }

    const result = await generate({
      jobId,
      bookId,
      genre: null,
      title: book.title,
      author: book.account.pen_name,
      ...(book.subtitle ? { subtitle: book.subtitle } : {}),
    });

    await prisma.kdpMetadata.update({
      where: { book_id: bookId },
      data: {
        title_kana: result.title_kana,
        title_romaji: result.title_romaji,
        subtitle_kana: result.subtitle_kana,
        subtitle_romaji: result.subtitle_romaji,
        author_kana: result.author_kana,
        author_romaji: result.author_romaji,
      },
    });

    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'done', finished_at: now(), error: null, result_json: { ...result } },
    });
    log.info({ task: PIPELINE_BOOK_READINGS_GENERATE_TASK_NAME, jobId, bookId }, 'readings generated');
  } catch (err) {
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'failed', finished_at: now(), error: serializeError(err) },
      });
    } catch (jobErr) {
      log.warn({ task: PIPELINE_BOOK_READINGS_GENERATE_TASK_NAME, jobId, bookId, err: jobErr }, 'failed to mark job failed');
    }
    throw err;
  }
}

function serializeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export const pipelineBookReadingsGenerateTask: Task = async (payload: unknown, helpers: JobHelpers) => {
  await runPipelineBookReadingsGenerate(payload, helpers.addJob as unknown as AddJobLike);
};
