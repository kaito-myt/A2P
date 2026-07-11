import { describe, expect, it, vi } from 'vitest';

import { runOrgOpsWatch, type OrgOpsWatchPrisma, type OrgOpsWatchDeps } from '../src/tasks/org-ops-watch.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
} as unknown as OrgOpsWatchDeps['logger'];

const NOW = new Date('2026-07-11T00:00:00Z');

interface JobRow {
  id: string;
  book_id: string | null;
  kind: string;
  status: string;
  retries: number;
  error: string | null;
  started_at: Date | null;
  created_at: Date;
}

function makeHarness(jobs: JobRow[], openOpsBooks: Array<string | null> = []) {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    job: {
      findMany: vi.fn(async () => jobs),
      update: vi.fn(async () => ({})),
    },
    orgTask: {
      findMany: vi.fn(async () => openOpsBooks.map((book_id) => ({ book_id }))),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: `t-${created.length}` };
      }),
    },
  } as unknown as OrgOpsWatchPrisma;
  return { prisma, created };
}

function failedJob(over: Partial<JobRow>): JobRow {
  return {
    id: 'j1',
    book_id: 'b1',
    kind: 'pipeline.book.editor',
    status: 'failed',
    retries: 1,
    error: 'boom',
    started_at: new Date('2026-07-10T23:00:00Z'),
    created_at: new Date('2026-07-10T23:30:00Z'),
    ...over,
  };
}

const deps = (prisma: OrgOpsWatchPrisma): OrgOpsWatchDeps => ({ prisma, logger: silentLogger, now: () => NOW });

describe('runOrgOpsWatch', () => {
  it('リトライ余地のある失敗ジョブ → recover_job(approved) を起票', async () => {
    const { prisma, created } = makeHarness([failedJob({ retries: 1 })]);
    const res = await runOrgOpsWatch({}, deps(prisma));
    expect(res.recover_created).toBe(1);
    expect(res.triage_created).toBe(0);
    expect(created[0]!.kind).toBe('recover_job');
    expect(created[0]!.status).toBe('approved');
    expect(created[0]!.assignee_role).toBe('ops_worker');
    expect(created[0]!.book_id).toBe('b1');
  });

  it('リトライ上限到達 → triage_error(needs_human) を起票', async () => {
    const { prisma, created } = makeHarness([failedJob({ retries: 3 })]);
    const res = await runOrgOpsWatch({}, deps(prisma));
    expect(res.triage_created).toBe(1);
    expect(res.recover_created).toBe(0);
    expect(created[0]!.kind).toBe('triage_error');
    expect(created[0]!.status).toBe('needs_human');
    expect(created[0]!.assignee_role).toBe('human');
  });

  it('長時間スタックの running → triage_error を起票', async () => {
    const { prisma, created } = makeHarness([
      failedJob({ status: 'running', retries: 0, error: null, started_at: new Date('2026-07-10T20:00:00Z') }),
    ]);
    const res = await runOrgOpsWatch({}, deps(prisma));
    expect(res.triage_created).toBe(1);
    expect(created[0]!.kind).toBe('triage_error');
  });

  it('既に開いている sysops タスクのある book は重複起票しない', async () => {
    const { prisma, created } = makeHarness([failedJob({ book_id: 'b1' })], ['b1']);
    const res = await runOrgOpsWatch({}, deps(prisma));
    expect(res.recover_created).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('同一 book の複数失敗は1件に集約（最新を代表）', async () => {
    const { prisma, created } = makeHarness([
      failedJob({ id: 'ja', kind: 'pipeline.book.marketer', created_at: new Date('2026-07-10T22:00:00Z') }),
      failedJob({ id: 'jb', kind: 'pipeline.book.editor', created_at: new Date('2026-07-10T23:00:00Z') }),
    ]);
    await runOrgOpsWatch({}, deps(prisma));
    expect(created).toHaveLength(1);
  });

  it('limit で起票数を絞る', async () => {
    const jobs = [
      failedJob({ id: 'j1', book_id: 'b1' }),
      failedJob({ id: 'j2', book_id: 'b2' }),
      failedJob({ id: 'j3', book_id: 'b3' }),
    ];
    const { prisma, created } = makeHarness(jobs);
    await runOrgOpsWatch({ limit: 2 }, deps(prisma));
    expect(created).toHaveLength(2);
  });
});
