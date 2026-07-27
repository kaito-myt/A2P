import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  isLineRelayConfigured,
  pushLine,
  requestOtpViaLine,
  type LineAuthRelayPrisma,
} from './line-auth-relay.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  status: string;
  code: string | null;
}

function makeFakePrisma() {
  const rows = new Map<string, FakeRow>();
  let n = 0;
  const create = vi.fn().mockImplementation((args: { data: { purpose: string; status: string; prompt: string; expires_at: Date } }) => {
    const id = `kar-${++n}`;
    rows.set(id, { id, status: args.data.status, code: null });
    return Promise.resolve({ id });
  });
  const findUnique = vi.fn().mockImplementation((args: { where: { id: string } }) =>
    Promise.resolve(rows.get(args.where.id) ?? null));
  const update = vi.fn().mockImplementation((args: { where: { id: string }; data: { status: string; code?: string | null } }) => {
    const row = rows.get(args.where.id);
    if (row) Object.assign(row, args.data);
    return Promise.resolve({});
  });
  const prisma: LineAuthRelayPrisma = { kdpAuthRequest: { create, findUnique, update } };
  return { prisma, rows, create, findUnique, update };
}

beforeEach(() => {
  process.env.LINE_CHANNEL_ACCESS_TOKEN = 'line-token-test';
  process.env.LINE_ALLOWED_USER_ID = 'U-test-user';
});

afterEach(() => {
  delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  delete process.env.LINE_ALLOWED_USER_ID;
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// isLineRelayConfigured
// ---------------------------------------------------------------------------

describe('isLineRelayConfigured', () => {
  it('LINE_CHANNEL_ACCESS_TOKEN と LINE_ALLOWED_USER_ID が両方あれば true', () => {
    expect(isLineRelayConfigured()).toBe(true);
  });

  it('片方でも欠けていれば false', () => {
    delete process.env.LINE_ALLOWED_USER_ID;
    expect(isLineRelayConfigured()).toBe(false);
  });

  it('両方無ければ false', () => {
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_ALLOWED_USER_ID;
    expect(isLineRelayConfigured()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pushLine
// ---------------------------------------------------------------------------

describe('pushLine', () => {
  it('2xx なら true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }));
    const ok = await pushLine('hello');
    expect(ok).toBe(true);
  });

  it('非 2xx なら false (throw しない)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' }));
    const ok = await pushLine('hello');
    expect(ok).toBe(false);
  });

  it('fetch が throw しても false (呼び出し元を止めない)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const ok = await pushLine('hello');
    expect(ok).toBe(false);
  });

  it('未設定なら fetch を呼ばず false', async () => {
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const ok = await pushLine('hello');
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// requestOtpViaLine
// ---------------------------------------------------------------------------

describe('requestOtpViaLine', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '' }));
  });

  it('fulfilled になったコードを返し、行を consumed にする', async () => {
    const { prisma, rows } = makeFakePrisma();

    const promise = requestOtpViaLine(prisma, {
      purpose: 'kdp_sales_relogin',
      prompt: 'test prompt',
      ttlMs: 50,
      pollMs: 5,
      maxWaitMs: 200,
    });

    // pending 行が作られた直後に運営者が返信した想定 (webhook が code+fulfilled を書き込む)。
    await new Promise((r) => setTimeout(r, 10));
    const [id] = rows.keys();
    rows.get(id!)!.status = 'fulfilled';
    rows.get(id!)!.code = '123456';

    const code = await promise;
    expect(code).toBe('123456');
    expect(rows.get(id!)!.status).toBe('consumed');
  });

  it('maxRounds=1 でタイムアウトすると null を返し、行を expired にする', async () => {
    const { prisma, rows } = makeFakePrisma();

    const code = await requestOtpViaLine(prisma, {
      purpose: 'kdp_sales_relogin',
      prompt: 'test prompt',
      ttlMs: 20,
      pollMs: 5,
      maxWaitMs: 20,
      maxRounds: 1,
    });

    expect(code).toBeNull();
    expect(rows.size).toBe(1);
    const [row] = rows.values();
    expect(row!.status).toBe('expired');
  });

  it('タイムアウト後に再送し、2ラウンド目で fulfilled になれば code を返す', async () => {
    const { prisma, rows, create } = makeFakePrisma();

    const promise = requestOtpViaLine(prisma, {
      purpose: 'kdp_sales_relogin',
      prompt: 'test prompt',
      ttlMs: 15,
      pollMs: 5,
      maxWaitMs: 15,
      maxRounds: 2,
    });

    // 1 ラウンド目は誰も返信しないのでタイムアウト → 2 ラウンド目の行が作られたら返信する。
    const start = Date.now();
    while (create.mock.calls.length < 2 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(create.mock.calls.length).toBe(2);
    // 2 ラウンド目の prompt は再送メッセージになっている。
    expect(String(create.mock.calls[1]![0].data.prompt)).toContain('2/2回目');

    const ids = Array.from(rows.keys());
    const secondId = ids[1]!;
    rows.get(secondId)!.status = 'fulfilled';
    rows.get(secondId)!.code = '654321';

    const code = await promise;
    expect(code).toBe('654321');
    // 1 ラウンド目は expired のまま。
    expect(rows.get(ids[0]!)!.status).toBe('expired');
    expect(rows.get(secondId)!.status).toBe('consumed');
  });

  it('全ラウンド未受信なら null を返す (maxRounds=2)', async () => {
    const { prisma, create } = makeFakePrisma();

    const code = await requestOtpViaLine(prisma, {
      purpose: 'kdp_sales_relogin',
      prompt: 'test prompt',
      ttlMs: 10,
      pollMs: 5,
      maxWaitMs: 10,
      maxRounds: 2,
    });

    expect(code).toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
  });
});
