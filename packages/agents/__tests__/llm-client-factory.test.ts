import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfigError } from '@a2p/contracts/errors';

// Prisma を引かないよう mock。各テストで loadAssignmentDeps 経由で repo を差し替える。
vi.mock('@a2p/db', () => ({
  prisma: {
    modelAssignment: { findFirst: vi.fn() },
    tokenUsage: { create: vi.fn() },
    book: { update: vi.fn() },
    modelCatalog: { findFirst: vi.fn() },
    apiCredential: { findUnique: vi.fn() },
  },
}));
vi.mock('@a2p/crypto', () => ({
  decryptApiKey: vi.fn((s: string) => `dec(${s})`),
}));

import { AISdkClient } from '../src/lib/ai-sdk-client.js';
import { AgentSdkClient } from '../src/lib/agent-sdk-client.js';
import { createAgentClient } from '../src/lib/llm-client-factory.js';
import { invalidateApiKeyCache } from '../src/lib/get-api-key.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SortOrder = 'asc' | 'desc';
type NullsOrder = 'first' | 'last';
type OrderBySpec = SortOrder | { sort: SortOrder; nulls?: NullsOrder };

/**
 * PostgreSQL の `ORDER BY` セマンティクスを正確に模す。
 *
 * WHY: 旧 mock は「DESC = NULLS LAST」を無条件適用しており、
 * 実装の `nulls: 'last'` 指定欠落バグを unit test で検知できなかった。
 * 実 DB: DESC 既定 = NULLS FIRST / ASC 既定 = NULLS LAST。
 */
function normalizeSpec(spec: OrderBySpec): { sort: SortOrder; nulls: NullsOrder } {
  if (typeof spec === 'string') {
    return { sort: spec, nulls: spec === 'desc' ? 'first' : 'last' };
  }
  return {
    sort: spec.sort,
    nulls: spec.nulls ?? (spec.sort === 'desc' ? 'first' : 'last'),
  };
}

function compareWithNulls(
  a: string | null,
  b: string | null,
  sort: SortOrder,
  nulls: NullsOrder,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return nulls === 'first' ? -1 : 1;
  if (b === null) return nulls === 'first' ? 1 : -1;
  if (a === b) return 0;
  const cmp = a < b ? -1 : 1;
  return sort === 'asc' ? cmp : -cmp;
}

function makeAssignmentRepo(
  rows: Array<{
    role: string;
    genre: string | null;
    provider: string;
    model: string;
    id?: string;
  }>,
) {
  return {
    modelAssignment: {
      findFirst: vi.fn(
        async (args: {
          where: { role: string; status: string; OR: Array<{ genre: string | null }> };
          orderBy: { genre: OrderBySpec };
        }) => {
          const allowed = new Set(args.where.OR.map((o) => o.genre));
          const hits = rows.filter(
            (r) => r.role === args.where.role && allowed.has(r.genre),
          );
          if (hits.length === 0) return null;
          const { sort, nulls } = normalizeSpec(args.orderBy.genre);
          hits.sort((a, b) => compareWithNulls(a.genre, b.genre, sort, nulls));
          const r = hits[0]!;
          return {
            id: r.id ?? 'assn-1',
            provider: r.provider,
            model: r.model,
            genre: r.genre,
          };
        },
      ),
    },
  };
}

const inMemoryPrisma = () => ({
  tokenUsage: { create: vi.fn() },
  book: { update: vi.fn() },
});

// `withTokenLogging` の Proxy 検証: 通常クラスのプロパティ取得をフックする副作用で
// `complete` を 1 度呼んで `tokenUsage.create` が走ることを確認する。
beforeEach(() => {
  invalidateApiKeyCache();
});

// ---------------------------------------------------------------------------
// 1. role=marketer + provider=anthropic → AgentSdkClient
// ---------------------------------------------------------------------------

describe('createAgentClient — 二層分岐', () => {
  it('role=marketer + provider=anthropic → AgentSdkClient (wrapped)', async () => {
    const assignRepo = makeAssignmentRepo([
      { role: 'marketer', genre: null, provider: 'anthropic', model: 'claude-opus-4-7' },
    ]);
    const prisma = inMemoryPrisma();

    const client = await createAgentClient(
      'marketer',
      null,
      { role: 'marketer', themeSessionId: 'ts-1' },
      {
        getApiKey: async () => 'sk-ant-test',
        loadAssignmentDeps: { prisma: assignRepo as never },
        withTokenLoggingDeps: { prisma: prisma as never, logger: { warn: vi.fn() }, fetchPriceSnapshot: async () => ({}) },
      },
    );

    // wrap された内部 target が AgentSdkClient であることを model 経由で確認
    expect((client as unknown as { model: string }).model).toBe('claude-opus-4-7');
    expect((client as unknown as { provider: string }).provider).toBe('anthropic');
    // Proxy 透過: AgentSdkClient のインスタンスっぽい振る舞いをしているはず
    // (instanceof は Proxy が target を委譲するため true になる)
    expect(client instanceof AgentSdkClient).toBe(true);
  });

  it('role=cover_art_direction + provider=anthropic → AgentSdkClient (売れ筋表紙の web リサーチ用)', async () => {
    const assignRepo = makeAssignmentRepo([
      { role: 'cover_art_direction', genre: null, provider: 'anthropic', model: 'claude-opus-4-7' },
    ]);
    const prisma = inMemoryPrisma();
    const client = await createAgentClient(
      'cover_art_direction',
      null,
      { role: 'cover_art_direction', bookId: 'b1' },
      {
        getApiKey: async () => 'sk-ant-test',
        loadAssignmentDeps: { prisma: assignRepo as never },
        withTokenLoggingDeps: { prisma: prisma as never, logger: { warn: vi.fn() }, fetchPriceSnapshot: async () => ({}) },
      },
    );
    expect(client instanceof AgentSdkClient).toBe(true);
  });

  it('role=writer + provider=anthropic → AISdkClient (Marketer 以外は AgentSdk を使わない)', async () => {
    const assignRepo = makeAssignmentRepo([
      { role: 'writer', genre: null, provider: 'anthropic', model: 'claude-opus-4-7' },
    ]);
    const prisma = inMemoryPrisma();
    const client = await createAgentClient(
      'writer',
      null,
      { role: 'writer' },
      {
        getApiKey: async () => 'sk-ant-test',
        loadAssignmentDeps: { prisma: assignRepo as never },
        withTokenLoggingDeps: { prisma: prisma as never, logger: { warn: vi.fn() }, fetchPriceSnapshot: async () => ({}) },
      },
    );

    expect(client instanceof AISdkClient).toBe(true);
    expect(client instanceof AgentSdkClient).toBe(false);
  });

  it('role=marketer + provider=openai → AISdkClient (Marketer でも provider が anthropic 以外なら AISdk)', async () => {
    const assignRepo = makeAssignmentRepo([
      { role: 'marketer', genre: null, provider: 'openai', model: 'gpt-5' },
    ]);
    const prisma = inMemoryPrisma();
    const client = await createAgentClient(
      'marketer',
      null,
      { role: 'marketer' },
      {
        getApiKey: async () => 'sk-openai',
        loadAssignmentDeps: { prisma: assignRepo as never },
        withTokenLoggingDeps: { prisma: prisma as never, logger: { warn: vi.fn() }, fetchPriceSnapshot: async () => ({}) },
      },
    );

    expect(client instanceof AISdkClient).toBe(true);
    expect(client instanceof AgentSdkClient).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. genre fallback
// ---------------------------------------------------------------------------

describe('createAgentClient — genre フォールバック', () => {
  it('role=editor + genre=business に一致行があればそれを使う', async () => {
    const assignRepo = makeAssignmentRepo([
      { role: 'editor', genre: null, provider: 'openai', model: 'gpt-default' },
      { role: 'editor', genre: 'business', provider: 'anthropic', model: 'claude-business' },
    ]);
    const prisma = inMemoryPrisma();
    const client = await createAgentClient(
      'editor',
      'business',
      { role: 'editor' },
      {
        getApiKey: async () => 'k',
        loadAssignmentDeps: { prisma: assignRepo as never },
        withTokenLoggingDeps: { prisma: prisma as never, logger: { warn: vi.fn() }, fetchPriceSnapshot: async () => ({}) },
      },
    );
    expect((client as unknown as { model: string }).model).toBe('claude-business');
  });

  it('回帰: 実装が orderBy で nulls: "last" を明示している (NULLS FIRST 既定では FAIL する)', async () => {
    const assignRepo = makeAssignmentRepo([
      { role: 'editor', genre: 'business', provider: 'anthropic', model: 'claude-business' },
    ]);
    await createAgentClient(
      'editor',
      'business',
      { role: 'editor' },
      {
        getApiKey: async () => 'k',
        loadAssignmentDeps: { prisma: assignRepo as never },
        withTokenLoggingDeps: {
          prisma: inMemoryPrisma() as never,
          logger: { warn: vi.fn() },
          fetchPriceSnapshot: async () => ({}),
        },
      },
    );
    const findFirstMock = assignRepo.modelAssignment.findFirst as unknown as {
      mock: { calls: unknown[][] };
    };
    const args = findFirstMock.mock.calls[0]![0] as {
      orderBy: { genre: unknown };
    };
    expect(args.orderBy.genre).toEqual({ sort: 'desc', nulls: 'last' });
  });

  it('genre 指定が無く genre=null フォールバックを使う', async () => {
    const assignRepo = makeAssignmentRepo([
      { role: 'editor', genre: null, provider: 'openai', model: 'gpt-default' },
    ]);
    const prisma = inMemoryPrisma();
    const client = await createAgentClient(
      'editor',
      'business',
      { role: 'editor' },
      {
        getApiKey: async () => 'k',
        loadAssignmentDeps: { prisma: assignRepo as never },
        withTokenLoggingDeps: { prisma: prisma as never, logger: { warn: vi.fn() }, fetchPriceSnapshot: async () => ({}) },
      },
    );
    expect((client as unknown as { model: string }).model).toBe('gpt-default');
  });

  it('assignment が無ければ ConfigError', async () => {
    const assignRepo = makeAssignmentRepo([]);
    await expect(
      createAgentClient(
        'judge',
        null,
        { role: 'judge' },
        {
          getApiKey: async () => 'k',
          loadAssignmentDeps: { prisma: assignRepo as never },
          withTokenLoggingDeps: { prisma: inMemoryPrisma() as never, logger: { warn: vi.fn() }, fetchPriceSnapshot: async () => ({}) },
        },
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('未対応 provider なら ConfigError (anthropic|openai|google 以外)', async () => {
    const assignRepo = makeAssignmentRepo([
      { role: 'writer', genre: null, provider: 'cohere', model: 'command' },
    ]);
    await expect(
      createAgentClient(
        'writer',
        null,
        { role: 'writer' },
        {
          getApiKey: async () => 'k',
          loadAssignmentDeps: { prisma: assignRepo as never },
          withTokenLoggingDeps: { prisma: inMemoryPrisma() as never, logger: { warn: vi.fn() }, fetchPriceSnapshot: async () => ({}) },
        },
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// 3. withTokenLogging wrapping verification
// ---------------------------------------------------------------------------

describe('createAgentClient — withTokenLogging で必ずラップされる', () => {
  it('返却された client.complete は AISdkClient.prototype.complete と別関数 (Proxy 経由)', async () => {
    const assignRepo = makeAssignmentRepo([
      { role: 'writer', genre: null, provider: 'openai', model: 'gpt-5' },
    ]);
    const prisma = inMemoryPrisma();

    const client = await createAgentClient(
      'writer',
      null,
      { role: 'writer', bookId: 'b-1' },
      {
        getApiKey: async () => 'k',
        loadAssignmentDeps: { prisma: assignRepo as never },
        withTokenLoggingDeps: {
          prisma: prisma as never,
          logger: { warn: vi.fn() },
          fetchPriceSnapshot: async () => ({ ok: 1 }),
        },
      },
    );

    // Proxy の target は AISdkClient (instanceof は target を委譲)
    expect(client instanceof AISdkClient).toBe(true);
    // ただし Proxy 越しの complete アクセスは wrapper 関数を返す (= prototype と !== )
    const accessed = (client as unknown as { complete: unknown }).complete;
    expect(accessed).not.toBe(AISdkClient.prototype.complete);
    expect(typeof accessed).toBe('function');
  });
});
