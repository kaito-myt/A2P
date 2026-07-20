/**
 * F-059 — content_creator エージェント単体テスト。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { LLMClient, LLMCompleteArgs, LLMCompleteResult } from '@a2p/contracts/agents';
import type { AccountContentOutput, ContentCreatorInput } from '@a2p/contracts/agents/content-creator';

vi.mock('@a2p/db', () => ({
  prisma: {
    prompt: { findFirst: vi.fn() },
    tokenUsage: { create: vi.fn() },
    modelAssignment: { findFirst: vi.fn() },
    apiCredential: { findUnique: vi.fn() },
  },
}));

const { createAccountContent } = await import('../../src/content-creator/index.js');
import type { ContentCreatorDeps } from '../../src/content-creator/index.js';

function out(): AccountContentOutput {
  return {
    posts: [
      { pillar: '時短術', body: 'メール返信は1日3回にまとめると集中力が戻る。' },
      { pillar: '習慣化', body: '新しい習慣は既存習慣の直後に置くと続く。' },
    ],
  };
}

function makeClient(o: AccountContentOutput): LLMClient {
  const complete = async <T = string>(_a: LLMCompleteArgs): Promise<LLMCompleteResult<T>> => ({
    text: o as unknown as T,
    usage: { inputTokens: 800, outputTokens: 400 },
    costJpy: 0,
    provider: 'anthropic',
    model: 'claude-opus-4-7',
  });
  return {
    complete: vi.fn(complete) as LLMClient['complete'],
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('unused');
    },
  };
}

function loadPromptStub() {
  return vi.fn(async () => ({
    template: '価値投稿を作る。対象:{channel_label} 長さ:{length_guide}',
    version: 1,
    promptId: 'p-cc-1',
    genre: null,
  }));
}

function input(overrides: Partial<ContentCreatorInput> = {}): ContentCreatorInput {
  return {
    channel: overrides.channel ?? 'x',
    concept: 'c',
    tone_of_voice: '敬体',
    pillars: overrides.pillars ?? [{ name: '時短術', description: 'd', example_post: 'e' }],
    target_readers: ['20代会社員'],
    sample_titles: ['朝1分の習慣術'],
    count: overrides.count ?? 4,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('createAccountContent', () => {
  it('AccountContentOutput を返す', async () => {
    const client = makeClient(out());
    const res = await createAccountContent(input(), {
      createAgentClient: vi.fn(async () => client),
      loadActivePrompt: loadPromptStub(),
    } as ContentCreatorDeps);
    expect(res.posts.length).toBe(2);
    expect(res.posts[0]!.pillar).toBe('時短術');
  });

  it('channel の length_guide をプロンプトに埋める', async () => {
    const client = makeClient(out());
    const load = loadPromptStub();
    await createAccountContent(input({ channel: 'x' }), {
      createAgentClient: vi.fn(async () => client),
      loadActivePrompt: load,
    } as ContentCreatorDeps);
    const arg = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LLMCompleteArgs;
    const sys = arg.messages.find((mm) => mm.role === 'system');
    expect(String(sys?.content)).toContain('140字'); // X の length_guide
  });
});
