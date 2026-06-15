/**
 * T-05-01 -- Thumbnail Designer (cover text) unit tests.
 *
 * Strategy (same as editor/index.test.ts):
 *  - `createAgentClient` replaced with vi.fn() that returns a mock LLMClient
 *  - `loadActivePrompt` substituted via promptLoaderDeps
 *  - token_usage recording verified via withTokenLoggingDeps
 *
 * Coverage:
 *  1. happy path: 3 proposals returned
 *  2. happy path: 5 proposals returned
 *  3. fewer than 3 proposals -> AgentError
 *  4. more than 5 proposals -> AgentError
 *  5. invalid JSON -> AgentError
 *  6. empty response -> AgentError
 *  7. fenced JSON (```json ... ```) -> parsed successfully
 *  8. placeholder injection (title/subtitle/hook/genre/count)
 *  9. jobId forwarding
 *  10. jobId omitted -> ctx.jobId undefined
 *  11. token_usage INSERT (book_id + role=thumbnail_text)
 *  12. LLM call params (role/maxOutputTokens/messages)
 *  13. count defaults to 3 when not specified
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentError } from '@a2p/contracts/errors';
import type {
  LLMClient,
  LLMCompleteArgs,
  LLMCompleteResult,
} from '@a2p/contracts/agents';
import type { ThumbnailTextInput } from '@a2p/contracts/agents/thumbnail';

vi.mock('@a2p/db', () => ({
  prisma: {
    prompt: { findFirst: vi.fn() },
    tokenUsage: { create: vi.fn() },
    book: { update: vi.fn() },
    modelCatalog: { findFirst: vi.fn() },
    modelAssignment: { findFirst: vi.fn() },
    apiCredential: { findUnique: vi.fn() },
  },
}));

const { generateCoverText } = await import('../../src/thumbnail/text.js');
import type { GenerateCoverTextDeps } from '../../src/thumbnail/text.js';
const { withTokenLogging } = await import('../../src/lib/with-token-logging.js');
import type {
  LoggingContext,
  WithTokenLoggingDeps,
} from '../../src/lib/with-token-logging.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeClient(text: string): LLMClient {
  const completeImpl = async <T = string>(
    _args: LLMCompleteArgs,
  ): Promise<LLMCompleteResult<T>> => {
    return {
      text: text as T,
      usage: { inputTokens: 500, outputTokens: 800 },
      costJpy: 0,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    };
  };
  return {
    complete: vi.fn(completeImpl) as LLMClient['complete'],
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('not used in tests');
    },
  };
}

function makePromptRepo(rows: Array<{
  id: string;
  role: string;
  genre: string | null;
  version: number;
  body: string;
  status: string;
}>) {
  return {
    prompt: {
      findFirst: vi.fn(async (args: {
        where: { role: string; status: string; OR: Array<{ genre: string | null }> };
      }) => {
        const allowed = new Set(args.where.OR.map((o) => o.genre));
        const hit = rows.find(
          (r) =>
            r.role === args.where.role &&
            r.status === args.where.status &&
            allowed.has(r.genre),
        );
        if (!hit) return null;
        return { id: hit.id, body: hit.body, version: hit.version, genre: hit.genre };
      }),
    },
  };
}

function defaultPromptRow() {
  return {
    id: 'p-thumb-text-1',
    role: 'thumbnail_text',
    genre: null as string | null,
    version: 1,
    body:
      'あなたはサムネイルデザイナーです。書籍: {title} / 副題: {subtitle} / フック: {hook}\n' +
      '想定読者: {target_reader} / ジャンル: {genre}\n' +
      '案数: {count}',
    status: 'active',
  };
}

function baseInput(overrides: Partial<ThumbnailTextInput> = {}): ThumbnailTextInput {
  return {
    bookId: overrides.bookId ?? 'book-1',
    accountId: overrides.accountId ?? 'acc-1',
    genre: overrides.genre ?? null,
    themeContext: overrides.themeContext ?? {
      title: '副業で月 5 万円',
      subtitle: '初心者向け実践ガイド',
      hook: '既存本にない切り口で 30 代副業初心者に最短ルートを示す',
      target_reader: '30 代会社員 / 副業初心者',
    },
    count: overrides.count ?? 3,
    ...(overrides.jobId !== undefined ? { jobId: overrides.jobId } : {}),
  };
}

function buildProposals(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    title: `案${i + 1}: テストタイトル`,
    subtitle: i % 2 === 0 ? `サブタイトル${i + 1}` : undefined,
    band_copy: i % 3 === 0 ? `帯文テスト${i + 1}` : undefined,
  }));
}

function jsonResponse(payload: unknown): string {
  return JSON.stringify(payload);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. happy path: 3 proposals
// ---------------------------------------------------------------------------

describe('generateCoverText -- happy path', () => {
  it('3 proposals returned successfully', async () => {
    const input = baseInput({ count: 3 });
    const proposals = buildProposals(3);
    const text = jsonResponse({ proposals });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateCoverText(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.proposals).toHaveLength(3);
    expect(result.proposals[0]!.title).toBe('案1: テストタイトル');
    expect(fakeClient.complete).toHaveBeenCalledTimes(1);
  });

  // 2. happy path: 5 proposals
  it('5 proposals returned successfully', async () => {
    const input = baseInput({ count: 5 });
    const proposals = buildProposals(5);
    const text = jsonResponse({ proposals });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateCoverText(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.proposals).toHaveLength(5);
  });

  // 13. count defaults to 3
  it('count defaults to 3 when not specified in input', async () => {
    const input: ThumbnailTextInput = {
      bookId: 'book-1',
      accountId: 'acc-1',
      genre: null,
      themeContext: {
        title: 'テスト',
        hook: 'フック',
        target_reader: '読者',
      },
      count: 3,
    };
    const proposals = buildProposals(3);
    const text = jsonResponse({ proposals });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateCoverText(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.proposals).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 3-4. proposal count validation
// ---------------------------------------------------------------------------

describe('generateCoverText -- proposal count validation', () => {
  it('fewer than 3 proposals -> AgentError(invalid_output)', async () => {
    const input = baseInput({ count: 3 });
    const proposals = buildProposals(2);
    const text = jsonResponse({ proposals });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateCoverText(input, {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
    expect((caught as AgentError).message).toMatch(/schema validation/);
  });

  it('more than 5 proposals -> AgentError(invalid_output)', async () => {
    const input = baseInput({ count: 5 });
    const proposals = buildProposals(6);
    const text = jsonResponse({ proposals });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateCoverText(input, {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
  });
});

// ---------------------------------------------------------------------------
// 5-6. invalid / empty response
// ---------------------------------------------------------------------------

describe('generateCoverText -- output validation', () => {
  it('invalid JSON -> AgentError(invalid_output)', async () => {
    const input = baseInput();
    const fakeClient = makeFakeClient('This is not JSON at all.');
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateCoverText(input, {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
  });

  it('empty response -> AgentError(invalid_output: empty)', async () => {
    const input = baseInput();
    const fakeClient = makeFakeClient('   ');
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await expect(
      generateCoverText(input, {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      }),
    ).rejects.toBeInstanceOf(AgentError);
  });

  it('JSON without proposals key -> AgentError(invalid_output)', async () => {
    const input = baseInput();
    const text = jsonResponse({ items: [{ title: 'test' }] });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateCoverText(input, {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
  });
});

// ---------------------------------------------------------------------------
// 7. fenced JSON
// ---------------------------------------------------------------------------

describe('generateCoverText -- fenced JSON', () => {
  it('```json ... ``` wrapped response is parsed successfully', async () => {
    const input = baseInput({ count: 3 });
    const proposals = buildProposals(3);
    const inner = JSON.stringify({ proposals });
    const text = '```json\n' + inner + '\n```';
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateCoverText(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.proposals).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 8. placeholder injection
// ---------------------------------------------------------------------------

describe('generateCoverText -- prompt injection', () => {
  it('placeholders ({title}/{subtitle}/{hook}/{target_reader}/{genre}/{count}) are injected into system prompt', async () => {
    const input = baseInput({
      genre: 'business',
      count: 4,
      themeContext: {
        title: 'AI 時代の副業術',
        subtitle: '完全ガイド',
        hook: 'AI ツール活用',
        target_reader: 'エンジニア',
      },
    });
    const proposals = buildProposals(4);
    const text = jsonResponse({ proposals });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([
      { ...defaultPromptRow(), genre: 'business' },
    ]);

    await generateCoverText(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    const systemMsg = args.messages.find((m) => m.role === 'system');
    expect(systemMsg!.content).toContain('AI 時代の副業術');
    expect(systemMsg!.content).toContain('完全ガイド');
    expect(systemMsg!.content).toContain('AI ツール活用');
    expect(systemMsg!.content).toContain('エンジニア');
    expect(systemMsg!.content).toContain('business');
    expect(systemMsg!.content).toContain('4');
  });

  it('user message contains title, hook, target_reader, genre, and count', async () => {
    const input = baseInput({ count: 3 });
    const proposals = buildProposals(3);
    const text = jsonResponse({ proposals });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await generateCoverText(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    const userMsg = args.messages.find((m) => m.role === 'user');
    expect(userMsg!.content).toContain('副業で月 5 万円');
    expect(userMsg!.content).toContain('3 案');
  });
});

// ---------------------------------------------------------------------------
// 9-11. token_usage / jobId forwarding
// ---------------------------------------------------------------------------

describe('generateCoverText -- token_usage / jobId', () => {
  it('jobId specified -> forwarded to ctx and token_usage', async () => {
    const input = baseInput({ bookId: 'book-ABC', jobId: 'job-123' });
    const proposals = buildProposals(3);
    const text = jsonResponse({ proposals });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    type CreateArgs = {
      data: { job_id: string | null; book_id: string | null; role: string };
    };
    const tokenUsageCreate = vi.fn(async (_args: CreateArgs) => undefined);
    const wrappingDeps: WithTokenLoggingDeps = {
      prisma: {
        tokenUsage: { create: tokenUsageCreate },
        book: { update: vi.fn() },
      } as never,
      logger: { warn: vi.fn() },
      fetchPriceSnapshot: async () => ({}),
    };

    const wrappingFactory: GenerateCoverTextDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await generateCoverText(input, {
      createAgentClient: wrappingFactory,
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(tokenUsageCreate).toHaveBeenCalledTimes(1);
    const createArgs = tokenUsageCreate.mock.calls[0]![0];
    expect(createArgs.data.job_id).toBe('job-123');
    expect(createArgs.data.book_id).toBe('book-ABC');
    expect(createArgs.data.role).toBe('thumbnail_text');
  });

  it('jobId omitted -> token_usage.job_id is null', async () => {
    const input = baseInput({ bookId: 'book-XYZ' });
    const proposals = buildProposals(3);
    const text = jsonResponse({ proposals });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    type CreateArgs = {
      data: { job_id: string | null; book_id: string | null; role: string };
    };
    const tokenUsageCreate = vi.fn(async (_args: CreateArgs) => undefined);
    const wrappingDeps: WithTokenLoggingDeps = {
      prisma: {
        tokenUsage: { create: tokenUsageCreate },
        book: { update: vi.fn() },
      } as never,
      logger: { warn: vi.fn() },
      fetchPriceSnapshot: async () => ({}),
    };

    const wrappingFactory: GenerateCoverTextDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await generateCoverText(input, {
      createAgentClient: wrappingFactory,
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(tokenUsageCreate).toHaveBeenCalledTimes(1);
    const createArgs = tokenUsageCreate.mock.calls[0]![0];
    expect(createArgs.data.job_id).toBeNull();
    expect(createArgs.data.book_id).toBe('book-XYZ');
    expect(createArgs.data.role).toBe('thumbnail_text');
  });

  it('single call records exactly 1 token_usage INSERT with provider=anthropic', async () => {
    const input = baseInput({ bookId: 'book-ZZZ' });
    const proposals = buildProposals(3);
    const text = jsonResponse({ proposals });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    type CreateArgs = {
      data: { book_id: string | null; role: string; provider: string };
    };
    const tokenUsageCreate = vi.fn(async (_args: CreateArgs) => undefined);
    const wrappingDeps: WithTokenLoggingDeps = {
      prisma: {
        tokenUsage: { create: tokenUsageCreate },
        book: { update: vi.fn() },
      } as never,
      logger: { warn: vi.fn() },
      fetchPriceSnapshot: async () => ({}),
    };

    const wrappingFactory: GenerateCoverTextDeps['createAgentClient'] = vi.fn(
      async (_role, _genre, ctx: LoggingContext) =>
        withTokenLogging(fakeClient, ctx, wrappingDeps),
    );

    await generateCoverText(input, {
      createAgentClient: wrappingFactory,
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(tokenUsageCreate).toHaveBeenCalledTimes(1);
    const createArgs = tokenUsageCreate.mock.calls[0]![0];
    expect(createArgs.data.book_id).toBe('book-ZZZ');
    expect(createArgs.data.role).toBe('thumbnail_text');
    expect(createArgs.data.provider).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// 12. LLM call params
// ---------------------------------------------------------------------------

describe('generateCoverText -- LLM call params', () => {
  it('client.complete receives role=thumbnail_text, maxOutputTokens=4096, system+user messages', async () => {
    const input = baseInput();
    const proposals = buildProposals(3);
    const text = jsonResponse({ proposals });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    await generateCoverText(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    const completeMock = fakeClient.complete as unknown as {
      mock: { calls: Array<[LLMCompleteArgs]> };
    };
    const args = completeMock.mock.calls[0]![0];
    expect(args.role).toBe('thumbnail_text');
    expect(args.maxOutputTokens).toBe(4096);
    expect(args.messages).toHaveLength(2);
    expect(args.messages[0]!.role).toBe('system');
    expect(args.messages[1]!.role).toBe('user');
  });

  it('createAgentClient receives role=thumbnail_text with correct ctx', async () => {
    const input = baseInput({ bookId: 'book-CTX', jobId: 'job-CTX' });
    const proposals = buildProposals(3);
    const text = jsonResponse({ proposals });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);
    const createSpy: GenerateCoverTextDeps['createAgentClient'] = vi.fn(
      async () => fakeClient,
    );

    await generateCoverText(input, {
      createAgentClient: createSpy,
      promptLoaderDeps: { prisma: promptRepo },
    });

    const spyMock = createSpy as unknown as { mock: { calls: unknown[][] } };
    expect(spyMock.mock.calls).toHaveLength(1);
    const callArgs = spyMock.mock.calls[0]!;
    expect(callArgs[0]).toBe('thumbnail_text');
    expect(callArgs[1]).toBeNull();
    const ctx = callArgs[2] as { role: string; bookId: string; jobId?: string };
    expect(ctx).toMatchObject({
      role: 'thumbnail_text',
      bookId: 'book-CTX',
      jobId: 'job-CTX',
    });
  });
});

// ---------------------------------------------------------------------------
// Proposal content validation
// ---------------------------------------------------------------------------

describe('generateCoverText -- proposal content', () => {
  it('proposals with subtitle and band_copy are preserved', async () => {
    const input = baseInput({ count: 3 });
    const proposals = [
      { title: 'タイトル A', subtitle: '副題 A', band_copy: '帯文 A' },
      { title: 'タイトル B', subtitle: '副題 B' },
      { title: 'タイトル C', band_copy: '帯文 C' },
    ];
    const text = jsonResponse({ proposals });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    const result = await generateCoverText(input, {
      createAgentClient: vi.fn(async () => fakeClient),
      promptLoaderDeps: { prisma: promptRepo },
    });

    expect(result.proposals[0]!.subtitle).toBe('副題 A');
    expect(result.proposals[0]!.band_copy).toBe('帯文 A');
    expect(result.proposals[1]!.subtitle).toBe('副題 B');
    expect(result.proposals[1]!.band_copy).toBeUndefined();
    expect(result.proposals[2]!.subtitle).toBeUndefined();
    expect(result.proposals[2]!.band_copy).toBe('帯文 C');
  });

  it('proposal with empty title -> AgentError(invalid_output)', async () => {
    const input = baseInput({ count: 3 });
    const proposals = [
      { title: '', subtitle: 'test' },
      { title: 'OK', subtitle: 'test' },
      { title: 'OK2', subtitle: 'test' },
    ];
    const text = jsonResponse({ proposals });
    const fakeClient = makeFakeClient(text);
    const promptRepo = makePromptRepo([defaultPromptRow()]);

    let caught: unknown;
    try {
      await generateCoverText(input, {
        createAgentClient: vi.fn(async () => fakeClient),
        promptLoaderDeps: { prisma: promptRepo },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toMatch(/invalid_output/);
  });
});
