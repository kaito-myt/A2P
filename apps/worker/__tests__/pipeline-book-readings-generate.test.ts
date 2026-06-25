import { describe, it, expect, vi } from 'vitest';

import {
  runPipelineBookReadingsGenerate,
  type PipelineBookReadingsGeneratePrisma,
} from '../src/tasks/pipeline-book-readings-generate.js';

const result = {
  title_kana: 'タイトル', title_romaji: 'taitoru',
  subtitle_kana: 'サブ', subtitle_romaji: 'sabu',
  author_kana: 'ミヤタカイト', author_romaji: 'miyatakaito',
};

function makePrisma(book: Record<string, unknown> | null) {
  const metaUpdates: Array<Record<string, unknown>> = [];
  const jobUpdates: Array<Record<string, unknown>> = [];
  const prisma: PipelineBookReadingsGeneratePrisma = {
    job: {
      findUnique: vi.fn(async () => ({ status: 'queued' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async (a: { data: Record<string, unknown> }) => { jobUpdates.push(a.data); return {}; }),
    },
    book: { findUnique: vi.fn(async () => book as never) },
    kdpMetadata: { update: vi.fn(async (a: { data: Record<string, string> }) => { metaUpdates.push(a.data); return {}; }) },
  };
  return { prisma, metaUpdates, jobUpdates };
}

const addJob = vi.fn(async () => undefined);

describe('runPipelineBookReadingsGenerate', () => {
  it('generates readings and writes them to KdpMetadata', async () => {
    const { prisma, metaUpdates, jobUpdates } = makePrisma({
      id: 'b1', title: 'タイトル', subtitle: 'サブ', account: { pen_name: '宮田海斗' }, kdpMetadata: { id: 'm1' },
    });
    const generateReadings = vi.fn(async () => result);
    await runPipelineBookReadingsGenerate({ book_id: 'b1', job_id: 'j1' }, addJob, { prisma, generateReadings, logger: { info: vi.fn(), warn: vi.fn() } as never });
    expect(generateReadings).toHaveBeenCalledTimes(1);
    expect(metaUpdates[0]).toMatchObject({ title_kana: 'タイトル', author_romaji: 'miyatakaito' });
    expect(jobUpdates.find((d) => d.status === 'done')).toBeTruthy();
  });

  it('skips (done) when book has no KdpMetadata', async () => {
    const { prisma, metaUpdates, jobUpdates } = makePrisma({
      id: 'b1', title: 'T', subtitle: null, account: { pen_name: 'A' }, kdpMetadata: null,
    });
    const generateReadings = vi.fn(async () => result);
    await runPipelineBookReadingsGenerate({ book_id: 'b1', job_id: 'j1' }, addJob, { prisma, generateReadings, logger: { info: vi.fn(), warn: vi.fn() } as never });
    expect(generateReadings).not.toHaveBeenCalled();
    expect(metaUpdates).toHaveLength(0);
    expect(jobUpdates.find((d) => d.status === 'done')).toBeTruthy();
  });
});
