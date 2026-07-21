import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@a2p/contracts/logger';
import type { ThumbnailImageInput, ThumbnailImageOutput } from '@a2p/contracts/agents/thumbnail';

import {
  runPipelineBookCoverRegenerate,
  type PipelineBookCoverRegenerateDeps,
  type PipelineBookCoverRegeneratePrisma,
} from '../src/tasks/pipeline-book-cover-regenerate.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

interface CoverRecord {
  id: string;
  book_id: string;
  cover_text_id: string | null;
  width: number;
  height: number;
  status: string;
}

interface ProposalRecord {
  id: string;
  book_id: string;
  title: string;
  subtitle: string | null;
  status: string;
}

interface BuildArgs {
  covers: CoverRecord[];
  proposals: ProposalRecord[];
}

function buildPrisma(args: BuildArgs) {
  const covers = args.covers.map((c) => ({ ...c }));
  const proposals = args.proposals.map((p) => ({ ...p }));
  const captures = {
    coverUpdates: [] as Array<{ id: string; status: string }>,
    coverUpdateMany: [] as Array<{ where: Record<string, unknown>; data: { status: string } }>,
    jobUpdates: [] as Array<Record<string, unknown>>,
  };

  const prisma: PipelineBookCoverRegeneratePrisma = {
    job: {
      findUnique: async () => ({ status: 'queued' }),
      updateMany: async () => ({ count: 1 }),
      update: async ({ data }) => {
        captures.jobUpdates.push(data as Record<string, unknown>);
        return {};
      },
      create: async () => ({ id: 'export_job_1' }),
    },
    book: {
      findUnique: async () => ({
        id: 'book_1',
        account: { pen_name: 'ペンネーム' },
        theme: null,
      }),
    },
    cover: {
      findFirst: async ({ where }) => {
        const match = covers.find(
          (c) =>
            c.book_id === where.book_id &&
            (where.id === undefined || c.id === where.id) &&
            (where.status === undefined || c.status === where.status),
        );
        return match
          ? {
              id: match.id,
              cover_text_id: match.cover_text_id,
              width: match.width,
              height: match.height,
              status: match.status,
            }
          : null;
      },
      update: async ({ where, data }) => {
        captures.coverUpdates.push({ id: where.id, status: data.status });
        const c = covers.find((x) => x.id === where.id);
        if (c) c.status = data.status;
        return { id: where.id };
      },
      updateMany: async ({ where, data }) => {
        captures.coverUpdateMany.push({ where, data });
        let count = 0;
        for (const c of covers) {
          if (
            c.book_id === where.book_id &&
            c.status === where.status &&
            c.id !== where.id.not
          ) {
            c.status = data.status;
            count += 1;
          }
        }
        return { count };
      },
    },
    coverTextProposal: {
      findUnique: async ({ where }) => {
        const p = proposals.find((x) => x.id === where.id);
        return p ? { title: p.title, subtitle: p.subtitle } : null;
      },
      findFirst: async ({ where }) => {
        const matches = proposals.filter(
          (p) =>
            p.book_id === where.book_id &&
            (where.status === undefined || p.status === where.status),
        );
        const p = matches[matches.length - 1];
        return p ? { id: p.id, title: p.title, subtitle: p.subtitle } : null;
      },
    },
  };

  return { prisma, captures, state: { covers, proposals } };
}

const GENERATED_IMAGE: ThumbnailImageOutput = {
  r2Key: 'covers/new_cover.jpg',
  promptUsed: 'prompt',
  coverId: 'new_cover',
};

function baseDeps(
  prisma: PipelineBookCoverRegeneratePrisma,
  captureInput: (input: ThumbnailImageInput) => void,
): PipelineBookCoverRegenerateDeps {
  return {
    prisma,
    logger: makeLogger(),
    now: () => new Date('2026-07-20T00:00:00Z'),
    generateCoverImage: async (input) => {
      captureInput(input);
      return GENERATED_IMAGE;
    },
    // theme is null in the fake book, so art direction generation is skipped.
    generateCoverArtDirection: vi.fn() as unknown as PipelineBookCoverRegenerateDeps['generateCoverArtDirection'],
  };
}

const addJobNoop = vi.fn().mockResolvedValue(undefined);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPipelineBookCoverRegenerate — commented cover targeting', () => {
  it('regenerates the commented cover candidate even when no cover is adopted, folding feedback into the style guide', async () => {
    const { prisma, captures, state } = buildPrisma({
      covers: [
        { id: 'cand_2', book_id: 'book_1', cover_text_id: 'ct_1', width: 1024, height: 1536, status: 'generated' },
      ],
      proposals: [
        { id: 'ct_1', book_id: 'book_1', title: 'タイトル', subtitle: 'サブ', status: 'proposed' },
      ],
    });

    let imageInput: ThumbnailImageInput | null = null;
    await runPipelineBookCoverRegenerate(
      { book_id: 'book_1', job_id: 'job_1', feedback: 'もっと明るい色にして', cover_id: 'cand_2' },
      addJobNoop,
      baseDeps(prisma, (i) => {
        imageInput = i;
      }),
    );

    // Fed the commented cover's cover_text and the feedback into the style guide.
    expect(imageInput).not.toBeNull();
    expect(imageInput!.coverTextId).toBe('ct_1');
    expect(imageInput!.styleGuide).toContain('もっと明るい色にして');

    // Commented candidate rejected, new cover adopted.
    expect(captures.coverUpdates).toEqual(
      expect.arrayContaining([
        { id: 'cand_2', status: 'rejected' },
        { id: 'new_cover', status: 'adopted' },
      ]),
    );
    expect(state.covers.find((c) => c.id === 'cand_2')!.status).toBe('rejected');

    // Job finished successfully with regenerated=true.
    const finalJob = captures.jobUpdates.find((u) => u.status === 'done');
    expect(finalJob).toBeDefined();
    const result = finalJob!.result_json as Record<string, unknown>;
    expect(result.regenerated).toBe(true);
    expect(result.target_cover_id).toBe('cand_2');
    expect(result.new_cover_id).toBe('new_cover');
  });

  it('adopt=false（修正コメント経由）: 新カバーを候補として残し、既存カバーを採用/reject しない', async () => {
    const { prisma, captures, state } = buildPrisma({
      covers: [
        { id: 'adopted_1', book_id: 'book_1', cover_text_id: 'ct_1', width: 1024, height: 1536, status: 'adopted' },
      ],
      proposals: [
        { id: 'ct_1', book_id: 'book_1', title: 'タイトル', subtitle: 'サブ', status: 'adopted' },
      ],
    });

    await runPipelineBookCoverRegenerate(
      { book_id: 'book_1', job_id: 'job_1', feedback: 'テイストを変えて', adopt: false },
      addJobNoop,
      baseDeps(prisma, () => {}),
    );

    // 既存の採用カバーは触らない・新カバーは adopted に昇格しない（generated のまま候補）。
    expect(captures.coverUpdates.find((u) => u.id === 'new_cover' && u.status === 'adopted')).toBeUndefined();
    expect(state.covers.find((c) => c.id === 'adopted_1')!.status).toBe('adopted');
    const finalJob = captures.jobUpdates.find((u) => u.status === 'done');
    const result = finalJob!.result_json as Record<string, unknown>;
    expect(result.regenerated).toBe(true);
    expect(result.adopted).toBe(false);
    expect(result.export_job_id).toBeNull();
  });

  it('falls back to the adopted CoverTextProposal when the target cover has no cover_text_id', async () => {
    const { prisma } = buildPrisma({
      covers: [
        { id: 'cand_x', book_id: 'book_1', cover_text_id: null, width: 1024, height: 1536, status: 'generated' },
      ],
      proposals: [
        { id: 'ct_old', book_id: 'book_1', title: '旧', subtitle: null, status: 'rejected' },
        { id: 'ct_ad', book_id: 'book_1', title: '採用テキスト', subtitle: '採用サブ', status: 'adopted' },
      ],
    });

    let imageInput: ThumbnailImageInput | null = null;
    await runPipelineBookCoverRegenerate(
      { book_id: 'book_1', job_id: 'job_1', feedback: 'フォントを変えて', cover_id: 'cand_x' },
      addJobNoop,
      baseDeps(prisma, (i) => {
        imageInput = i;
      }),
    );

    expect(imageInput).not.toBeNull();
    // Resolved cover text from the adopted proposal, not the null cover_text_id.
    expect(imageInput!.coverTextId).toBe('ct_ad');
    expect(imageInput!.title).toBe('採用テキスト');
  });

  it('no-ops honestly (regenerated=false) when neither the commented nor an adopted cover exists', async () => {
    const { prisma, captures } = buildPrisma({
      covers: [],
      proposals: [{ id: 'ct_1', book_id: 'book_1', title: 'T', subtitle: null, status: 'adopted' }],
    });

    let called = false;
    await runPipelineBookCoverRegenerate(
      { book_id: 'book_1', job_id: 'job_1', feedback: 'x', cover_id: 'missing' },
      addJobNoop,
      baseDeps(prisma, () => {
        called = true;
      }),
    );

    expect(called).toBe(false);
    const finalJob = captures.jobUpdates.find((u) => u.status === 'done');
    expect(finalJob).toBeDefined();
    expect((finalJob!.result_json as Record<string, unknown>).regenerated).toBe(false);
  });
});
