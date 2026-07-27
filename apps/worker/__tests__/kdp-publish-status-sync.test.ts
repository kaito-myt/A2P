import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { encryptKdpCredentials } from '@a2p/crypto';
import type { Logger } from '@a2p/contracts/logger';

import { mapStatusLabel } from '../src/tasks/book-cull/playwright-bookshelf-port.js';
import type { BookshelfPort, ReadBookStatusResult } from '../src/tasks/book-cull/bookshelf-port.js';
import {
  runKdpPublishStatusSync,
  type KdpPublishStatusSyncPrisma,
} from '../src/tasks/kdp-publish-status-sync.js';

const silent = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  trace: vi.fn(),
  child: () => silent,
} as unknown as Logger;

const KEY = Buffer.alloc(32, 0x01);

beforeEach(() => {
  process.env.KDP_CRED_KEY = KEY.toString('hex');
});

afterEach(() => {
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_ALLOWED_USER_ID;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// mapStatusLabel (純関数)
// ---------------------------------------------------------------------------

describe('mapStatusLabel', () => {
  it('販売中 → live', () => {
    expect(mapStatusLabel('販売中')).toBe('live');
    expect(mapStatusLabel('タイトルXYZ 販売中 その他操作')).toBe('live');
  });
  it('下書き → draft', () => {
    expect(mapStatusLabel('下書き')).toBe('draft');
  });
  it('レビュー中 → in_review', () => {
    expect(mapStatusLabel('レビュー中')).toBe('in_review');
    expect(mapStatusLabel('In Review')).toBe('in_review');
  });
  it('ブロック → blocked', () => {
    expect(mapStatusLabel('ブロック')).toBe('blocked');
    expect(mapStatusLabel('Blocked')).toBe('blocked');
  });
  it('未知の文言 → not_found (安全側デフォルト)', () => {
    expect(mapStatusLabel('謎のステータス')).toBe('not_found');
    expect(mapStatusLabel('')).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// runKdpPublishStatusSync
// ---------------------------------------------------------------------------

const sess = encryptKdpCredentials(JSON.stringify({ cookies: [], origins: [] }), KEY);

interface Book {
  id: string;
  asin: string | null;
  title: string;
}

function makeMockPrisma(opts: {
  sessionEnc?: string | null;
  hasAccount?: boolean;
  books?: Book[];
}) {
  const bookUpdates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const auditWrites: Array<{ data: Record<string, unknown> }> = [];
  const books = opts.books ?? [];
  const hasAccount = opts.hasAccount ?? true;
  const sessionEnc = opts.sessionEnc !== undefined ? opts.sessionEnc : sess;

  const prisma: KdpPublishStatusSyncPrisma = {
    account: {
      findFirst: vi.fn().mockResolvedValue(
        hasAccount ? { id: 'acc-1', kdp_session_state_enc: sessionEnc } : null,
      ),
    },
    book: {
      findMany: vi.fn().mockResolvedValue(books),
      update: vi.fn().mockImplementation((args: { where: { id: string }; data: Record<string, unknown> }) => {
        bookUpdates.push(args);
        return Promise.resolve({});
      }),
    },
    auditLog: {
      create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
        auditWrites.push(args);
        return Promise.resolve({});
      }),
    },
  };
  return { prisma, bookUpdates, auditWrites };
}

function makePort(byBookId: Record<string, ReadBookStatusResult>): { port: BookshelfPort; calls: string[] } {
  const calls: string[] = [];
  const port: BookshelfPort = {
    async takedownBook() {
      throw new Error('not used in this test');
    },
    async readBookStatus(args) {
      const key = args.asin ?? args.title;
      calls.push(key);
      return byBookId[key] ?? { ok: true, status: 'not_found' };
    },
  };
  return { port, calls };
}

describe('runKdpPublishStatusSync', () => {
  it('(a) submitted + live 検知 → published に更新 + audit_log 書き込み', async () => {
    const { prisma, bookUpdates, auditWrites } = makeMockPrisma({
      books: [{ id: 'book-1', asin: 'B0LIVE0001', title: '売れる本' }],
    });
    const { port, calls } = makePort({ B0LIVE0001: { ok: true, status: 'live' } });

    const res = await runKdpPublishStatusSync({
      bookshelfPort: port,
      prisma,
      logger: silent,
      now: () => new Date('2026-07-27T00:00:00Z'),
    });

    expect(res).toEqual({ checked: 1, promoted: 1 });
    expect(calls).toEqual(['B0LIVE0001']);
    expect(bookUpdates).toHaveLength(1);
    expect(bookUpdates[0]!.where).toEqual({ id: 'book-1' });
    expect(bookUpdates[0]!.data.publish_status).toBe('published');
    expect(auditWrites).toHaveLength(1);
    expect(auditWrites[0]!.data.action).toBe('kdp.publish.published');
    expect(auditWrites[0]!.data.target_id).toBe('book-1');
  });

  it('(b) submitted + draft 検知 → 更新しない', async () => {
    const { prisma, bookUpdates, auditWrites } = makeMockPrisma({
      books: [{ id: 'book-2', asin: 'B0DRAFT002', title: '審査待ちの本' }],
    });
    const { port, calls } = makePort({ B0DRAFT002: { ok: true, status: 'draft' } });

    const res = await runKdpPublishStatusSync({ bookshelfPort: port, prisma, logger: silent });

    expect(res).toEqual({ checked: 1, promoted: 0 });
    expect(calls).toEqual(['B0DRAFT002']);
    expect(bookUpdates).toHaveLength(0);
    expect(auditWrites).toHaveLength(0);
  });

  it('(c) セッション未設定 → 何もせず終了 (book.findMany / port は呼ばれない)', async () => {
    const { prisma } = makeMockPrisma({ sessionEnc: null, books: [{ id: 'book-3', asin: 'B0X', title: 'x' }] });
    const { port, calls } = makePort({});

    const res = await runKdpPublishStatusSync({ bookshelfPort: port, prisma, logger: silent });

    expect(res).toEqual({ checked: 0, promoted: 0 });
    expect(calls).toEqual([]);
    expect(prisma.book.findMany).not.toHaveBeenCalled();
  });

  it('(c-2) 有効なアカウントが無い → 何もせず終了', async () => {
    const { prisma } = makeMockPrisma({ hasAccount: false });
    const { port, calls } = makePort({});

    const res = await runKdpPublishStatusSync({ bookshelfPort: port, prisma, logger: silent });

    expect(res).toEqual({ checked: 0, promoted: 0 });
    expect(calls).toEqual([]);
    expect(prisma.book.findMany).not.toHaveBeenCalled();
  });

  it('(d) セッション期限切れ検知 → 走査を中断し LINE 通知を試みる', async () => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'line-token-test';
    process.env.LINE_ALLOWED_USER_ID = 'U-test-user';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const { prisma, bookUpdates } = makeMockPrisma({
      books: [
        { id: 'book-4', asin: 'B0EXPIRED4', title: '1冊目' },
        { id: 'book-5', asin: 'B0NEVER0005', title: '2冊目(到達しないはず)' },
      ],
    });
    const { port, calls } = makePort({
      B0EXPIRED4: { ok: false, reason: 'session_expired', message: 'sign-in redirect' },
    });

    const res = await runKdpPublishStatusSync({ bookshelfPort: port, prisma, logger: silent });

    expect(res).toEqual({ checked: 1, promoted: 0 });
    expect(calls).toEqual(['B0EXPIRED4']); // 2冊目には到達しない (連打防止)
    expect(bookUpdates).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.messages[0].text).toContain('KDP本棚の閲覧セッションが切れています');
  });

  it('セッション期限切れでも LINE 未設定なら push を試みない', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { prisma } = makeMockPrisma({
      books: [{ id: 'book-6', asin: 'B0EXPIRED6', title: '1冊目' }],
    });
    const { port } = makePort({
      B0EXPIRED6: { ok: false, reason: 'session_expired', message: 'sign-in redirect' },
    });

    const res = await runKdpPublishStatusSync({ bookshelfPort: port, prisma, logger: silent });

    expect(res).toEqual({ checked: 1, promoted: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('action_failed 等の一時的失敗はスキップして次の本を継続する', async () => {
    const { prisma, bookUpdates } = makeMockPrisma({
      books: [
        { id: 'book-7', asin: 'B0FAIL0007', title: '失敗する本' },
        { id: 'book-8', asin: 'B0LIVE0008', title: '正常な本' },
      ],
    });
    const { port, calls } = makePort({
      B0FAIL0007: { ok: false, reason: 'action_failed', message: 'search box not found' },
      B0LIVE0008: { ok: true, status: 'live' },
    });

    const res = await runKdpPublishStatusSync({ bookshelfPort: port, prisma, logger: silent });

    expect(res).toEqual({ checked: 2, promoted: 1 });
    expect(calls).toEqual(['B0FAIL0007', 'B0LIVE0008']);
    expect(bookUpdates).toHaveLength(1);
    expect(bookUpdates[0]!.where).toEqual({ id: 'book-8' });
  });
});
