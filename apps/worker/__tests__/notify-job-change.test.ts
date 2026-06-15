/**
 * notify-job-change.ts のユニットテスト (T-03-11, docs/05 §1.4).
 *
 * 検証:
 *   - prisma.$executeRawUnsafe が `SELECT pg_notify($1, $2)` で呼ばれる
 *   - 第 1 引数はチャネル名 `jobs` (docs/05 §1.4 / ADR-001)
 *   - 第 2 引数は JSON 文字列で jobId/status/kind/updated_at が含まれる
 *   - bookId は optional → 渡せば JSON に含まれる
 *   - $executeRawUnsafe が throw しても本関数は throw しない (warn ログに残す)
 */
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@a2p/contracts/logger';

import {
  JOB_NOTIFY_CHANNEL,
  notifyJobChange,
  type NotifyJobChangePrisma,
} from '../src/lib/notify-job-change.js';

function makeLogger() {
  const calls: Array<{
    level: 'info' | 'warn' | 'error';
    obj: Record<string, unknown>;
    msg: string;
  }> = [];
  const mk =
    (level: 'info' | 'warn' | 'error') =>
    (obj: Record<string, unknown>, msg?: string) => {
      calls.push({ level, obj, msg: msg ?? '' });
    };
  const logger = {
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  return { logger, calls };
}

describe('JOB_NOTIFY_CHANNEL', () => {
  it('docs/05 §1.4 / ADR-001 と整合 (jobs)', () => {
    expect(JOB_NOTIFY_CHANNEL).toBe('jobs');
  });
});

describe('notifyJobChange — happy path', () => {
  it('prisma.$executeRawUnsafe を SELECT pg_notify($1, $2) で呼ぶ', async () => {
    const captured: Array<{ sql: string; values: unknown[] }> = [];
    const prisma: NotifyJobChangePrisma = {
      $executeRawUnsafe: async (sql, ...values) => {
        captured.push({ sql, values });
        return 1;
      },
    };
    const { logger } = makeLogger();
    const fixedNow = new Date('2026-05-23T01:02:03.456Z');

    const result = await notifyJobChange(
      {
        jobId: 'job_abc',
        status: 'done',
        kind: 'pipeline.book.kickoff',
        bookId: 'book_xyz',
      },
      { prisma, logger, now: () => fixedNow },
    );

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toBe('SELECT pg_notify($1, $2)');
    expect(captured[0]?.values[0]).toBe('jobs');

    const jsonStr = captured[0]?.values[1] as string;
    expect(typeof jsonStr).toBe('string');
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    expect(parsed).toEqual({
      jobId: 'job_abc',
      status: 'done',
      kind: 'pipeline.book.kickoff',
      bookId: 'book_xyz',
      updated_at: '2026-05-23T01:02:03.456Z',
    });
  });

  it('bookId を省略すると JSON にも含まれない', async () => {
    const captured: Array<{ values: unknown[] }> = [];
    const prisma: NotifyJobChangePrisma = {
      $executeRawUnsafe: async (_sql, ...values) => {
        captured.push({ values });
        return 1;
      },
    };
    const { logger } = makeLogger();

    await notifyJobChange(
      {
        jobId: 'job_1',
        status: 'running',
        kind: 'pipeline.book.marketer',
      },
      { prisma, logger, now: () => new Date('2026-05-23T00:00:00Z') },
    );

    const parsed = JSON.parse(captured[0]?.values[1] as string) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('bookId');
    expect(parsed).toMatchObject({
      jobId: 'job_1',
      status: 'running',
      kind: 'pipeline.book.marketer',
    });
  });

  it('logger を省略しても動作する', async () => {
    const prisma: NotifyJobChangePrisma = {
      $executeRawUnsafe: async () => 1,
    };
    const result = await notifyJobChange(
      { jobId: 'j', status: 'done', kind: 'pipeline.book.kickoff' },
      { prisma },
    );
    expect(result.ok).toBe(true);
  });
});

describe('notifyJobChange — error path (warn のみ、throw しない)', () => {
  it('$executeRawUnsafe が throw しても本関数は throw せず ok=false を返す', async () => {
    const boom = new Error('connection refused');
    const prisma: NotifyJobChangePrisma = {
      $executeRawUnsafe: async () => {
        throw boom;
      },
    };
    const { logger, calls } = makeLogger();

    const result = await notifyJobChange(
      { jobId: 'job_1', status: 'failed', kind: 'pipeline.book.kickoff' },
      { prisma, logger },
    );

    expect(result.ok).toBe(false);

    const warnCall = calls.find((c) => c.level === 'warn');
    expect(warnCall).toBeDefined();
    expect(warnCall?.obj).toMatchObject({
      channel: 'jobs',
      jobId: 'job_1',
      status: 'failed',
      kind: 'pipeline.book.kickoff',
    });
    expect(warnCall?.obj.err).toContain('connection refused');
  });

  it('$executeRawUnsafe が非 Error 値を throw しても warn にシリアライズされる', async () => {
    const prisma: NotifyJobChangePrisma = {
      $executeRawUnsafe: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw 'string error';
      },
    };
    const { logger, calls } = makeLogger();

    const result = await notifyJobChange(
      { jobId: 'job_x', status: 'done', kind: 'pipeline.book.kickoff' },
      { prisma, logger },
    );

    expect(result.ok).toBe(false);
    const warnCall = calls.find((c) => c.level === 'warn');
    expect(warnCall?.obj.err).toBe('string error');
  });
});
