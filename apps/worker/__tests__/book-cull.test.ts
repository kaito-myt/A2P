import { describe, it, expect, vi } from 'vitest';

import { isCullCandidate } from '@a2p/db/book-cull';
import { runBookCullDetect } from '../src/tasks/book-cull-detect.js';
import { runKdpBookTakedown } from '../src/tasks/kdp-book-takedown.js';
import {
  createFixtureBookshelfPort,
  createSessionExpiredBookshelfPort,
} from '../src/tasks/book-cull/bookshelf-port.js';
import { encryptKdpCredentials } from '@a2p/crypto';
import type { Logger } from '@a2p/contracts/logger';

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: () => silent } as unknown as Logger;
const KEY = Buffer.alloc(32, 0x01);
process.env.KDP_CRED_KEY = KEY.toString('hex');

describe('isCullCandidate', () => {
  const t = { minAgeDays: 60, maxKenp: 300, maxRoyaltyJpy: 100 };
  it('高齢×低KENP×低売上 → 候補', () => {
    expect(isCullCandidate({ ageDays: 70, cumKenp: 100, cumRoyaltyJpy: 50 }, t)).toBe(true);
  });
  it('新しい本は対象外', () => {
    expect(isCullCandidate({ ageDays: 30, cumKenp: 0, cumRoyaltyJpy: 0 }, t)).toBe(false);
  });
  it('売れている本は残す', () => {
    expect(isCullCandidate({ ageDays: 90, cumKenp: 100, cumRoyaltyJpy: 500 }, t)).toBe(false);
    expect(isCullCandidate({ ageDays: 90, cumKenp: 5000, cumRoyaltyJpy: 0 }, t)).toBe(false);
  });
});

describe('runBookCullDetect', () => {
  it('無効なら何もしない', async () => {
    const prisma = { appSettings: { findUnique: vi.fn(async () => ({ book_cull_enabled: false })) } } as never;
    const res = await runBookCullDetect({ prisma, logger: silent });
    expect(res).toEqual({ enabled: false, candidates: 0 });
  });
  it('有効なら候補を candidate にマークする', async () => {
    const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
    const prisma = {
      appSettings: { findUnique: vi.fn(async () => ({ book_cull_enabled: true, book_cull_min_age_days: 60, book_cull_max_kenp: 300, book_cull_max_royalty_jpy: 100 })) },
      book: { update: vi.fn(async (a: { where: unknown; data: Record<string, unknown> }) => { updates.push(a); return {}; }) },
    } as never;
    const res = await runBookCullDetect({
      prisma,
      logger: silent,
      now: () => new Date('2026-07-24T00:00:00Z'),
      getCandidates: async () => [
        { book_id: 'b1', title: 'x', asin: 'B0X', account_id: 'a', done_at: new Date('2026-05-01'), age_days: 84, cum_kenp: 10, cum_royalty_jpy: 0, quality_score: 77 },
      ],
    });
    expect(res).toEqual({ enabled: true, candidates: 1 });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.data.cull_status).toBe('candidate');
    expect(String(updates[0]!.data.cull_reason)).toContain('公開84日');
  });
});

describe('runKdpBookTakedown', () => {
  function mockPrisma(sessionEnc: string | null, asin: string | null) {
    const bookUpdates: Array<Record<string, unknown>> = [];
    const promoUpdates: Array<Record<string, unknown>> = [];
    const prisma = {
      book: {
        findUnique: vi.fn(async () => ({ id: 'b1', asin, account: { kdp_session_state_enc: sessionEnc } })),
        update: vi.fn(async (a: { data: Record<string, unknown> }) => { bookUpdates.push(a.data); return {}; }),
      },
      promotionPost: { updateMany: vi.fn(async (a: { data: Record<string, unknown> }) => { promoUpdates.push(a.data); return { count: 0 }; }) },
    } as never;
    return { prisma, bookUpdates, promoUpdates };
  }
  const sess = encryptKdpCredentials(JSON.stringify({ cookies: [], origins: [] }), KEY);

  it('成功 → status=retracted, cull_status=taken_down, 販促停止', async () => {
    const { prisma, bookUpdates, promoUpdates } = mockPrisma(sess, 'B0ABC12345');
    const res = await runKdpBookTakedown({
      payload: { book_id: 'b1', mode: 'unpublish_archive' },
      browserPort: createFixtureBookshelfPort('archived'),
      prisma, logger: silent,
    });
    expect(res.ok).toBe(true);
    expect(res.finalState).toBe('archived');
    expect(bookUpdates[0]).toMatchObject({ status: 'retracted', cull_status: 'taken_down' });
    expect(promoUpdates[0]).toMatchObject({ status: 'canceled' });
  });

  it('セッション期限切れ → ok:false, 状態変更しない', async () => {
    const { prisma, bookUpdates } = mockPrisma(sess, 'B0ABC12345');
    const res = await runKdpBookTakedown({
      payload: { book_id: 'b1', mode: 'unpublish_archive' },
      browserPort: createSessionExpiredBookshelfPort(),
      prisma, logger: silent,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('session_expired');
    // retracted への更新はされない(cull_reason の失敗記録のみ)
    expect(bookUpdates.some((d) => d.status === 'retracted')).toBe(false);
  });

  it('セッション未設定 → no_session', async () => {
    const { prisma } = mockPrisma(null, 'B0ABC12345');
    const res = await runKdpBookTakedown({
      payload: { book_id: 'b1', mode: 'unpublish_archive' },
      browserPort: createFixtureBookshelfPort(),
      prisma, logger: silent,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no_session');
  });
});
