import { describe, it, expect, vi } from 'vitest';

import {
  runPipelineBookCoverRecheck,
  type PipelineBookCoverRecheckDeps,
  type PipelineBookCoverRecheckPrisma,
} from '../src/tasks/pipeline-book-cover-recheck.js';

const okVerdict = {
  ok: true,
  title_legible: true,
  title_matches: true,
  garbled_text_detected: false,
  extra_text_detected: false,
  transcribed_text: 'タイトル',
  issues: [],
  confidence: 0.95,
};
const badVerdict = { ...okVerdict, ok: false, title_legible: false, garbled_text_detected: true };

function makePrisma(covers: Array<Record<string, unknown>>) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  const jobUpdates: Array<Record<string, unknown>> = [];
  const prisma: PipelineBookCoverRecheckPrisma = {
    job: {
      findUnique: vi.fn(async () => ({ status: 'queued' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async (a: { data: Record<string, unknown> }) => {
        jobUpdates.push(a.data);
        return {};
      }),
    },
    cover: {
      findMany: vi.fn(async () => covers as never),
      update: vi.fn(async (a: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: a.where.id, data: a.data });
        return {};
      }),
    },
    coverTextProposal: {
      findUnique: vi.fn(async () => ({ title: '副業で稼ぐ', subtitle: '初心者ガイド' })),
    },
  };
  return { prisma, updates, jobUpdates };
}

function baseDeps(
  prisma: PipelineBookCoverRecheckPrisma,
  over: Partial<PipelineBookCoverRecheckDeps> = {},
): PipelineBookCoverRecheckDeps {
  return {
    prisma,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    downloadBuffer: vi.fn(async () => Buffer.from('IMG')),
    verifyCoverText: vi.fn(async () => okVerdict),
    generateCoverImage: vi.fn(async () => ({ r2Key: 'k', promptUsed: 'p', coverId: 'new' })),
    now: () => new Date('2026-06-25T00:00:00Z'),
    ...over,
  };
}

const addJob = vi.fn(async () => undefined);

describe('runPipelineBookCoverRecheck', () => {
  it('records verdict on every checked cover and finishes the job', async () => {
    const { prisma, updates, jobUpdates } = makePrisma([
      { id: 'c1', status: 'generated', r2_key: 'r1', cover_text_id: 'p1', width: 1024, height: 1536, generation_meta_json: {} },
      { id: 'c2', status: 'adopted', r2_key: 'r2', cover_text_id: 'p2', width: 1024, height: 1536, generation_meta_json: {} },
    ]);
    const deps = baseDeps(prisma);

    await runPipelineBookCoverRecheck({ book_id: 'b1', job_id: 'j1' }, addJob, deps);

    // both covers get a text_check verdict written
    expect(updates.filter((u) => 'generation_meta_json' in u.data)).toHaveLength(2);
    expect(deps.generateCoverImage).not.toHaveBeenCalled();
    const done = jobUpdates.find((d) => d.status === 'done');
    expect(done?.result_json).toMatchObject({ checked: 2, garbled: 0, regenerated: 0 });
  });

  it('regenerates garbled generated covers and rejects the old candidate', async () => {
    const { prisma, updates, jobUpdates } = makePrisma([
      { id: 'c1', status: 'generated', r2_key: 'r1', cover_text_id: 'p1', width: 1024, height: 1536, generation_meta_json: {} },
    ]);
    const deps = baseDeps(prisma, { verifyCoverText: vi.fn(async () => badVerdict) });

    await runPipelineBookCoverRecheck({ book_id: 'b1', job_id: 'j1' }, addJob, deps);

    expect(deps.generateCoverImage).toHaveBeenCalledTimes(1);
    // old cover marked rejected
    expect(updates.some((u) => u.id === 'c1' && u.data.status === 'rejected')).toBe(true);
    const done = jobUpdates.find((d) => d.status === 'done');
    expect(done?.result_json).toMatchObject({ checked: 1, garbled: 1, regenerated: 1 });
  });

  it('flags garbled adopted covers without auto-regenerating', async () => {
    const { prisma, updates, jobUpdates } = makePrisma([
      { id: 'c1', status: 'adopted', r2_key: 'r1', cover_text_id: 'p1', width: 1024, height: 1536, generation_meta_json: {} },
    ]);
    const deps = baseDeps(prisma, { verifyCoverText: vi.fn(async () => badVerdict) });

    await runPipelineBookCoverRecheck({ book_id: 'b1', job_id: 'j1' }, addJob, deps);

    expect(deps.generateCoverImage).not.toHaveBeenCalled();
    expect(updates.some((u) => u.id === 'c1' && u.data.status === 'rejected')).toBe(false);
    const done = jobUpdates.find((d) => d.status === 'done');
    expect(done?.result_json).toMatchObject({ checked: 1, garbled: 1, regenerated: 0 });
  });

  it('skips when job already done (idempotent)', async () => {
    const { prisma } = makePrisma([]);
    prisma.job.findUnique = vi.fn(async () => ({ status: 'done' }));
    const deps = baseDeps(prisma);

    await runPipelineBookCoverRecheck({ book_id: 'b1', job_id: 'j1' }, addJob, deps);

    expect(prisma.cover.findMany).not.toHaveBeenCalled();
  });
});
