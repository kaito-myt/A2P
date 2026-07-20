/**
 * F-057 — sns_strategist エージェント単体テスト。
 *  - createAgentClient / loadActivePrompt を deps で差し替え
 *  - planSnsStrategy が AccountStrategyProfile を返す
 *  - generateStrategyImages が avatar/banner を生成し、文字なしガードを付ける
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type {
  LLMClient,
  LLMCompleteArgs,
  LLMCompleteResult,
} from '@a2p/contracts/agents';
import type {
  AccountStrategyProfile,
  SnsStrategistInput,
} from '@a2p/contracts/agents/sns-strategist';

vi.mock('@a2p/db', () => ({
  prisma: {
    prompt: { findFirst: vi.fn() },
    tokenUsage: { create: vi.fn() },
    modelAssignment: { findFirst: vi.fn() },
    apiCredential: { findUnique: vi.fn() },
  },
}));

const { planSnsStrategy, generateStrategyImages } = await import('../../src/sns-strategist/index.js');
import type { SnsStrategistDeps } from '../../src/sns-strategist/index.js';

function validProfile(): AccountStrategyProfile {
  return {
    concept: '毎朝1つ、明日から使える仕事術を配るアカウント',
    display_name: '仕事術ラボ',
    handle_suggestion: 'shigoto_lab',
    bio: '忙しい20〜30代に向けて、明日から使える仕事術を毎朝ひとつ。実用書の著者が運営。',
    content_pillars: [
      { name: '時短術', description: '今日から削れる無駄を1つ', example_post: 'メール返信は1日3回にまとめると集中力が戻る。' },
      { name: '思考整理', description: '頭の中を軽くする問い', example_post: '「これは自分がやるべき?」を朝に3回問う。' },
      { name: '習慣化', description: '続く仕組み', example_post: '新習慣は既存習慣の直後に置くと定着する。' },
    ],
    tone_of_voice: '敬体・断定しすぎない・絵文字は控えめ',
    posting_cadence: { frequency: '平日は1日1投稿', best_times: ['07:30', '21:00'] },
    hashtag_strategy: { core: ['#仕事術', '#タスク管理'], rotating: ['#朝活'] },
    growth_tactics: ['朝の時間帯に投稿', '反応が良い投稿はスレッドで深掘り'],
    avatar_prompt: 'ミニマルな朝日のアイコン、暖色',
    banner_prompt: '静かなデスクの俯瞰、暖色の朝の光',
  };
}

function makeClient(profile: AccountStrategyProfile): LLMClient {
  const complete = async <T = string>(_args: LLMCompleteArgs): Promise<LLMCompleteResult<T>> => ({
    text: JSON.stringify(profile) as unknown as T,
    usage: { inputTokens: 1000, outputTokens: 400 },
    costJpy: 0,
    provider: 'anthropic',
    model: 'claude-opus-4-7',
  });
  return {
    complete: vi.fn(complete) as LLMClient['complete'],
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('not used');
    },
  };
}

function loadPromptStub() {
  return vi.fn(async (_role: string, _genre: string | null) => ({
    template: 'あなたは SNS 設計担当。対象: {channel_label} bio上限: {bio_limit}',
    version: 1,
    promptId: 'p-sns-1',
    genre: null,
  }));
}

function baseInput(overrides: Partial<SnsStrategistInput> = {}): SnsStrategistInput {
  return {
    channel: overrides.channel ?? 'x',
    current_handle: overrides.current_handle ?? '@kaitomyt',
    catalog: overrides.catalog ?? {
      genre_inventory: { business: 5, practical: 3 },
      sample_titles: ['朝1分の習慣術', '会議を半分にする技術'],
      target_readers: ['20〜30代の会社員'],
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('planSnsStrategy', () => {
  it('AccountStrategyProfile を返す', async () => {
    const client = makeClient(validProfile());
    const createAgentClient = vi.fn(async () => client);
    const result = await planSnsStrategy(baseInput(), {
      createAgentClient,
      loadActivePrompt: loadPromptStub(),
    } as SnsStrategistDeps);

    expect(result.display_name).toBe('仕事術ラボ');
    expect(result.content_pillars.length).toBeGreaterThanOrEqual(3);
    expect(result.hashtag_strategy.core).toContain('#仕事術');
    // role='sns_strategist' で client を作る
    expect(createAgentClient).toHaveBeenCalledWith(
      'sns_strategist',
      null,
      expect.objectContaining({ role: 'sns_strategist' }),
      expect.anything(),
    );
  });

  it('channel ごとに bio_limit プレースホルダを埋める', async () => {
    const client = makeClient(validProfile());
    const load = loadPromptStub();
    await planSnsStrategy(baseInput({ channel: 'tiktok' }), {
      createAgentClient: vi.fn(async () => client),
      loadActivePrompt: load,
    } as SnsStrategistDeps);
    // system プロンプトに tiktok の bio 上限(80)が反映される
    const sysArg = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LLMCompleteArgs;
    const sysMsg = sysArg.messages.find((mm) => mm.role === 'system');
    expect(String(sysMsg?.content)).toContain('80');
  });
});

describe('generateStrategyImages', () => {
  it('avatar/banner を生成し、文字なしガードを付ける', async () => {
    const calls: Array<{ prompt: string; width: number; height: number }> = [];
    const genImage = vi.fn(async (args: { prompt: string; width: number; height: number }) => {
      calls.push({ prompt: args.prompt, width: args.width, height: args.height });
      return { images: [Buffer.from(`img-${calls.length}`)], costJpy: 0, usage: { imageCount: 1 } };
    });

    const out = await generateStrategyImages(
      { avatar_prompt: '朝日のアイコン', banner_prompt: 'デスクの俯瞰' },
      { generateImage: genImage as never },
    );

    expect(out.avatar).toBeInstanceOf(Buffer);
    expect(out.banner).toBeInstanceOf(Buffer);
    expect(genImage).toHaveBeenCalledTimes(2);
    // 正方形アバター + 横長バナー
    expect(calls[0]!).toMatchObject({ width: 1024, height: 1024 });
    expect(calls[1]!).toMatchObject({ width: 1536, height: 1024 });
    // 文字を描かせないガードが両方に含まれる
    expect(calls[0]!.prompt).toContain('文字');
    expect(calls[1]!.prompt).toContain('文字');
  });
});
