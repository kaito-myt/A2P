import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@a2p/contracts/logger';

import {
  LOCKS_SWEEP_TASK_NAME,
  runLocksSweep,
} from '../src/tasks/locks-sweep.js';

function makeLogger() {
  const calls: Array<{
    level: 'info' | 'warn' | 'error';
    obj: Record<string, unknown>;
    msg: string;
  }> = [];
  const mk = (level: 'info' | 'warn' | 'error') =>
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

describe('locks.sweep task', () => {
  it('task identifier が docs/05 §5.4 と一致する', () => {
    expect(LOCKS_SWEEP_TASK_NAME).toBe('locks.sweep');
  });

  it('runLocksSweep: prisma.bookLock.deleteMany を expires_at < now で呼ぶ', async () => {
    const { logger, calls } = makeLogger();
    const captured: Array<{ where: unknown }> = [];
    const deleteMany = async (args: { where: unknown }): Promise<{ count: number }> => {
      captured.push(args);
      return { count: 3 };
    };
    const now = new Date('2026-05-22T10:00:00Z');

    const result = await runLocksSweep({
      prisma: {
        bookLock: {
          deleteMany,
          // sweep は create/findUnique を呼ばないが、型を満たすためダミー
          create: vi.fn() as never,
          findUnique: vi.fn() as never,
        },
      },
      logger,
      now: () => now,
    });

    expect(result.deletedCount).toBe(3);
    expect(captured).toHaveLength(1);
    const arg = captured[0]!.where as { expires_at: { lt: Date } };
    expect(arg.expires_at.lt).toEqual(now);

    // start と done ログが出ている
    const messages = calls.map((c) => c.msg);
    expect(messages.some((m) => m.includes('start'))).toBe(true);
    expect(messages.some((m) => m.includes('done'))).toBe(true);
    // done ログに deletedCount が含まれる
    const doneLog = calls.find((c) => c.msg.includes('done'));
    expect(doneLog!.obj).toMatchObject({ deletedCount: 3 });
  });

  it('runLocksSweep: 0 件削除でも正常終了し deletedCount=0 を返す', async () => {
    const { logger } = makeLogger();
    const result = await runLocksSweep({
      prisma: {
        bookLock: {
          deleteMany: async () => ({ count: 0 }),
          create: vi.fn() as never,
          findUnique: vi.fn() as never,
        },
      },
      logger,
      now: () => new Date('2026-05-22T10:00:00Z'),
    });
    expect(result.deletedCount).toBe(0);
  });

  it('runLocksSweep: deleteMany が throw → 例外がそのまま伝播 (graphile-worker のリトライ機構に委譲)', async () => {
    const { logger } = makeLogger();
    const boom = new Error('DB unavailable');
    await expect(
      runLocksSweep({
        prisma: {
          bookLock: {
            deleteMany: async () => {
              throw boom;
            },
            create: vi.fn() as never,
            findUnique: vi.fn() as never,
          },
        },
        logger,
        now: () => new Date('2026-05-22T10:00:00Z'),
      }),
    ).rejects.toBe(boom);
  });
});
