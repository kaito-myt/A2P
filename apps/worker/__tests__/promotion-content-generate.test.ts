/**
 * F-059 — promotion.content.generate タスクの単体テスト。
 */
import { describe, expect, it, vi } from 'vitest';

import type { AccountStrategyProfile } from '@a2p/contracts/agents/sns-strategist';
import type { ContentCreatorInput } from '@a2p/contracts/agents/content-creator';

import { runPromotionContentGenerate } from '../src/tasks/promotion-content-generate.js';

function strategy(): AccountStrategyProfile {
  return {
    concept: '毎朝1つ仕事術',
    display_name: '仕事術ラボ',
    handle_suggestion: 'shigoto_lab',
    bio: 'b',
    content_pillars: [
      { name: '時短術', description: 'd', example_post: 'e' },
      { name: '習慣化', description: 'd', example_post: 'e' },
      { name: '思考整理', description: 'd', example_post: 'e' },
    ],
    tone_of_voice: '敬体',
    posting_cadence: { frequency: 'f', best_times: [] },
    hashtag_strategy: { core: ['#仕事術'], rotating: [] },
    growth_tactics: ['g1', 'g2'],
    avatar_prompt: 'a',
    banner_prompt: 'b',
  };
}

function makeDeps(strategyJson: unknown) {
  const createMany = vi.fn(async (a: { data: unknown[] }) => ({ count: a.data.length }));
  const deleteMany = vi.fn(async () => ({ count: 0 }));
  const create = vi.fn(async (_i: ContentCreatorInput) => ({
    posts: [
      { pillar: '時短術', body: 'メールは1日3回に。' },
      { pillar: '習慣化', body: '習慣は直後に置く。' },
    ],
  }));
  const prisma = {
    promotionChannelSetting: { findUnique: vi.fn(async () => ({ strategy_json: strategyJson })) },
    book: { findMany: vi.fn(async () => [{ title: '朝1分の習慣術', theme: { target_reader: '20代' } }]) },
    promotionPost: { deleteMany, createMany },
  };
  return { prisma, createMany, deleteMany, create };
}

describe('runPromotionContentGenerate', () => {
  it('戦略の柱から value 投稿(book_id=null, kind=value)を生成しハッシュタグを付ける', async () => {
    const { prisma, createMany, create } = makeDeps(strategy());
    const res = await runPromotionContentGenerate(
      { channel: 'x', count: 2 },
      { prisma: prisma as never, createAccountContent: create, now: () => new Date('2026-07-20T00:00:00Z') },
    );
    expect(res.created).toBe(2);
    // content_creator に柱・トーンを渡している
    const inp = create.mock.calls[0]![0];
    expect(inp.channel).toBe('x');
    expect(inp.pillars.length).toBe(3);
    // 生成された投稿は kind=value / book_id=null / 定番ハッシュタグ付き
    const rows = createMany.mock.calls[0]![0].data as Array<{ kind: string; book_id: null; body: string; scheduled_for: Date }>;
    expect(rows.every((r) => r.kind === 'value')).toBe(true);
    expect(rows.every((r) => r.book_id === null)).toBe(true);
    expect(rows.some((r) => r.body.includes('#仕事術'))).toBe(true);
    // 明日以降に予約
    expect(rows[0]!.scheduled_for.getTime()).toBeGreaterThan(new Date('2026-07-20T00:00:00Z').getTime());
  });

  it('戦略が無ければ何もしない', async () => {
    const { prisma, createMany, create } = makeDeps(null);
    const res = await runPromotionContentGenerate(
      { channel: 'x' },
      { prisma: prisma as never, createAccountContent: create },
    );
    expect(res).toEqual({ created: 0, removed: 0 });
    expect(create).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it('不正 payload は throw', async () => {
    const { prisma, create } = makeDeps(strategy());
    await expect(
      runPromotionContentGenerate({ channel: 'bad' }, { prisma: prisma as never, createAccountContent: create }),
    ).rejects.toThrow();
  });
});
