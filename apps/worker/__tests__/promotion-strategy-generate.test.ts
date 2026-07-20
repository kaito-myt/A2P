/**
 * F-057 — promotion.strategy.generate タスクの単体テスト。
 * 全依存 (plan/画像/upload/prisma) を DI で差し替え、副作用を検証する。
 */
import { describe, expect, it, vi } from 'vitest';

import type { AccountStrategyProfile } from '@a2p/contracts/agents/sns-strategist';

import {
  runPromotionStrategyGenerate,
  PromotionStrategyGeneratePayloadSchema,
} from '../src/tasks/promotion-strategy-generate.js';

function profile(): AccountStrategyProfile {
  return {
    concept: 'c',
    display_name: '仕事術ラボ',
    handle_suggestion: 'shigoto_lab',
    bio: 'b',
    content_pillars: [
      { name: 'a', description: 'd', example_post: 'e' },
      { name: 'a2', description: 'd', example_post: 'e' },
      { name: 'a3', description: 'd', example_post: 'e' },
    ],
    tone_of_voice: 't',
    posting_cadence: { frequency: 'f', best_times: [] },
    hashtag_strategy: { core: ['#仕事術'], rotating: [] },
    growth_tactics: ['g1', 'g2'],
    avatar_prompt: 'av',
    banner_prompt: 'ba',
  };
}

function makeDeps() {
  const upsert = vi.fn(
    async (_args: {
      where: { channel: string };
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    }) => ({}),
  );
  const uploads: string[] = [];
  return {
    upsert,
    uploads,
    deps: {
      prisma: {
        promotionChannelSetting: {
          findUnique: vi.fn(async () => ({ handle: '@kaitomyt' })),
          upsert,
        },
        book: {
          findMany: vi.fn(async () => [
            { title: '朝1分の習慣術', theme: { genre: 'business', target_reader: '20代会社員' } },
            { title: '会議を半分に', theme: { genre: 'practical', target_reader: null } },
          ]),
        },
      },
      now: () => new Date('2026-07-19T00:00:00Z'),
      planSnsStrategy: vi.fn(async () => profile()),
      generateStrategyImages: vi.fn(async () => ({
        avatar: Buffer.from('a'),
        banner: Buffer.from('b'),
      })),
      // withImageLogging を回避するため generateImage は使わないが、型を満たすダミー
      generateImage: vi.fn(async () => ({ images: [Buffer.from('x')], costJpy: 0, usage: { imageCount: 1 } })),
      uploadBuffer: vi.fn(async (key: string) => {
        uploads.push(key);
        return { key };
      }),
    },
  };
}

describe('PromotionStrategyGeneratePayloadSchema', () => {
  it('channel を検証する', () => {
    expect(PromotionStrategyGeneratePayloadSchema.safeParse({ channel: 'x' }).success).toBe(true);
    expect(PromotionStrategyGeneratePayloadSchema.safeParse({ channel: 'sns' }).success).toBe(false);
  });
});

describe('runPromotionStrategyGenerate', () => {
  it('プロファイル生成→画像→R2保存→upsert を行う', async () => {
    const { deps, upsert, uploads } = makeDeps();
    const res = await runPromotionStrategyGenerate({ channel: 'x' }, deps as never);

    expect(res.channel).toBe('x');
    expect(res.display_name).toBe('仕事術ラボ');
    // アバター/バナー2枚を R2 に保存
    expect(uploads).toEqual([
      'promotion/x/meta/avatar.png',
      'promotion/x/meta/banner.jpg',
    ]);
    // 永続化: display_name / strategy_json / 画像キー / 更新時刻
    const call = upsert.mock.calls[0]![0];
    expect(call.where.channel).toBe('x');
    expect(call.update.display_name).toBe('仕事術ラボ');
    expect(call.update.avatar_key).toBe('promotion/x/meta/avatar.png');
    expect((call.update.strategy_json as AccountStrategyProfile).handle_suggestion).toBe('shigoto_lab');
  });

  it('カタログ (在庫ジャンル/読者/書名) を plan に渡す', async () => {
    const { deps } = makeDeps();
    await runPromotionStrategyGenerate({ channel: 'tiktok' }, deps as never);
    const planArg = (deps.planSnsStrategy as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(planArg.channel).toBe('tiktok');
    expect(planArg.current_handle).toBe('@kaitomyt');
    expect(planArg.catalog.genre_inventory).toMatchObject({ business: 1, practical: 1 });
    expect(planArg.catalog.sample_titles).toContain('朝1分の習慣術');
    expect(planArg.catalog.target_readers).toContain('20代会社員');
  });

  it('不正 payload は ValidationError', async () => {
    const { deps } = makeDeps();
    await expect(runPromotionStrategyGenerate({ channel: 'bad' }, deps as never)).rejects.toThrow();
  });
});
