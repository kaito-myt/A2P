/**
 * F-060 — TikTok 多エージェント台本パイプラインの単体テスト。
 * 5 ロールを順に回し、各段が前段の出力を受けて VideoScript を返す。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { LLMClient, LLMCompleteArgs, LLMCompleteResult } from '@a2p/contracts/agents';
import type { TikTokVideoInput } from '@a2p/contracts/agents/tiktok-video';

vi.mock('@a2p/db', () => ({
  prisma: {
    prompt: { findFirst: vi.fn() },
    tokenUsage: { create: vi.fn() },
    modelAssignment: { findFirst: vi.fn() },
    apiCredential: { findUnique: vi.fn() },
  },
}));

const { createTikTokVideoScript } = await import('../../src/tiktok-video/index.js');
import type { TikTokVideoDeps } from '../../src/tiktok-video/index.js';

const scene = { narration: 'ナレーション文です。', caption: 'テロップ', image_prompt: '縦型の背景', seconds: 3 };
const scenario = {
  hook: '9割が知らない事実',
  beats: [
    { role: 'hook', narration: '実はほとんどの人が…' },
    { role: 'reveal', narration: '答えはシンプルで…' },
  ],
  cliffhanger: '続きはプロフィールから',
};
const storyboard = { scenes: [{ narration: 'a', caption: 'b', image_prompt: 'c' }, { narration: 'd', caption: 'e', image_prompt: 'f' }] };
const script = { title: '仕事術', scenes: [scene, scene], caption: '続きが気になる本文', hashtags: ['#仕事術'] };

/** ロールごとに異なる JSON を返すクライアント。 */
function makeClientForRole(role: string): LLMClient {
  const payload =
    role === 'tiktok_scenario'
      ? scenario
      : role === 'tiktok_creator'
        ? storyboard
        : script; // editor / proofreader / marketer は VideoScript
  const complete = async <T = string>(_a: LLMCompleteArgs): Promise<LLMCompleteResult<T>> => ({
    text: JSON.stringify(payload) as unknown as T,
    usage: { inputTokens: 500, outputTokens: 300 },
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
  return vi.fn(async (_role: string) => ({
    template: '台本を作る。尺:{target_seconds}',
    version: 1,
    promptId: 'p',
    genre: null,
  }));
}

function input(overrides: Partial<TikTokVideoInput> = {}): TikTokVideoInput {
  return {
    channel: 'tiktok',
    concept: 'がんばらない処方箋',
    tone_of_voice: '敬体',
    topic: 'いい人をやめる',
    sample_titles: ['朝1分の習慣術'],
    core_hashtags: ['#ゆるり文庫'],
    target_seconds: 30,
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('createTikTokVideoScript', () => {
  it('5 ロールを順に呼び VideoScript を返す', async () => {
    const roles: string[] = [];
    const createAgentClient = vi.fn(async (role: string) => {
      roles.push(role);
      return makeClientForRole(role);
    });
    const result = await createTikTokVideoScript(input(), {
      createAgentClient: createAgentClient as never,
      loadActivePrompt: loadPromptStub(),
    } as TikTokVideoDeps);

    expect(roles).toEqual([
      'tiktok_scenario',
      'tiktok_creator',
      'tiktok_editor',
      'tiktok_proofreader',
      'tiktok_marketer',
    ]);
    expect(result.scenes.length).toBe(2);
    expect(result.caption).toBeTruthy();
    expect(result.title).toBe('仕事術');
  });
});
