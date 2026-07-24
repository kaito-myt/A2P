/**
 * F-061 — runPromotionReviewDaily の単体テスト（LLM/prisma を DI）。
 */
import { describe, expect, it, vi } from 'vitest';

import { runPromotionReviewDaily } from '../src/tasks/promotion-review-daily.js';

const strategy = {
  concept: 'ゆるり文庫',
  tone_of_voice: '穏やかで誠実',
  content_pillars: [{ name: '習慣', description: '習慣化のコツ' }],
  hashtag_strategy: { core: ['読書', '習慣化'] },
  posting_cadence: { frequency: '毎日1回', best_times: [] },
  growth_tactics: ['丁寧に反応する'],
  display_name: 'ゆるり文庫',
  handle_suggestion: 'yururi',
  bio: 'b',
  avatar_prompt: 'a',
  banner_prompt: 'b',
};

function buildPrisma(opts: {
  channels?: Array<{ channel: string; strategy_json: unknown }>;
  upcoming?: Array<{ id: string; kind: string; body: string }>;
  posted?: Array<{ body: string }>;
}) {
  const updates: Array<{ id: string; body: string }> = [];
  const prisma = {
    promotionChannelSetting: {
      findMany: vi.fn(async () => opts.channels ?? [{ channel: 'x', strategy_json: strategy }]),
    },
    promotionPost: {
      findMany: vi.fn(async (args: { where: { status: string } }) =>
        args.where.status === 'scheduled' ? (opts.upcoming ?? []) : (opts.posted ?? []),
      ),
      update: vi.fn(async (args: { where: { id: string }; data: { body: string } }) => {
        updates.push({ id: args.where.id, body: args.data.body });
        return {};
      }),
    },
  };
  return { prisma, updates };
}

describe('runPromotionReviewDaily', () => {
  it('変更ありの予定投稿だけ本文を更新する', async () => {
    const { prisma, updates } = buildPrisma({
      upcoming: [
        { id: 'p1', kind: 'value', body: '古い本文A' },
        { id: 'p2', kind: 'value', body: '据え置き本文B' },
      ],
    });
    const optimize = vi.fn(async () => ({
      revisions: [
        { id: 'p1', changed: true, revised_body: '改善された本文A（フック付き）', reason: 'フック追加' , score: 80, on_strategy: true, persona_reaction: '' },
        { id: 'p2', changed: false, revised_body: '据え置き本文B', reason: '' , score: 80, on_strategy: true, persona_reaction: '' },
      ],
    }));
    const res = await runPromotionReviewDaily({}, { prisma: prisma as never, optimize, now: () => new Date('2026-07-22T00:00:00Z') });
    expect(res.updated).toBe(1);
    expect(updates).toEqual([{ id: 'p1', body: '改善された本文A（フック付き）' }]);
  });

  it('販促投稿で URL が消える改善は破棄する（購入導線を守る）', async () => {
    const url = 'https://www.amazon.co.jp/dp/XXXX';
    const { prisma, updates } = buildPrisma({
      upcoming: [{ id: 'promo1', kind: 'promo', body: `新刊です ${url}` }],
    });
    const optimize = vi.fn(async () => ({
      revisions: [{ id: 'promo1', changed: true, revised_body: 'URLを消してしまった本文', reason: 'x' , score: 80, on_strategy: true, persona_reaction: '' }],
    }));
    const res = await runPromotionReviewDaily({}, { prisma: prisma as never, optimize, now: () => new Date('2026-07-22T00:00:00Z') });
    expect(res.updated).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('販促投稿で URL を保持した改善は採用する', async () => {
    const url = 'https://www.amazon.co.jp/dp/XXXX';
    const { prisma, updates } = buildPrisma({
      upcoming: [{ id: 'promo2', kind: 'promo', body: `新刊です ${url}` }],
    });
    const optimize = vi.fn(async () => ({
      revisions: [{ id: 'promo2', changed: true, revised_body: `【新刊】読めば変わる。${url}`, reason: 'x' , score: 80, on_strategy: true, persona_reaction: '' }],
    }));
    const res = await runPromotionReviewDaily({}, { prisma: prisma as never, optimize, now: () => new Date('2026-07-22T00:00:00Z') });
    expect(res.updated).toBe(1);
    expect(updates[0]!.body).toContain(url);
  });

  it('内部メモ/id が本文に漏れた改善は破棄する（公開事故防止）', async () => {
    const { prisma, updates } = buildPrisma({
      upcoming: [
        { id: 'v1', kind: 'value', body: '元の育成本文' },
        { id: 'v2', kind: 'value', body: '別の育成本文' },
      ],
    });
    const optimize = vi.fn(async () => ({
      revisions: [
        { id: 'v1', changed: true, revised_body: '良い本文。\n\nid=v2 の投稿と内容が近いので公開タイミングの分散をご検討ください。', reason: '' , score: 80, on_strategy: true, persona_reaction: '' },
        { id: 'v2', changed: true, revised_body: '普通に改善された本文', reason: '' , score: 80, on_strategy: true, persona_reaction: '' },
      ],
    }));
    const res = await runPromotionReviewDaily({}, { prisma: prisma as never, optimize, now: () => new Date('2026-07-22T00:00:00Z') });
    // v1 は漏洩でスキップ、v2 のみ採用
    expect(updates.map((u) => u.id)).toEqual(['v2']);
    expect(res.updated).toBe(1);
  });

  it('予定投稿が無ければ optimize を呼ばない', async () => {
    const { prisma } = buildPrisma({ upcoming: [] });
    const optimize = vi.fn();
    const res = await runPromotionReviewDaily({}, { prisma: prisma as never, optimize: optimize as never, now: () => new Date('2026-07-22T00:00:00Z') });
    expect(optimize).not.toHaveBeenCalled();
    expect(res.updated).toBe(0);
  });

  it('LLM 失敗時はそのチャンネルをスキップして続行', async () => {
    const { prisma, updates } = buildPrisma({ upcoming: [{ id: 'p1', kind: 'value', body: 'x' }] });
    const optimize = vi.fn(async () => { throw new Error('LLM down'); });
    const res = await runPromotionReviewDaily({}, { prisma: prisma as never, optimize, now: () => new Date('2026-07-22T00:00:00Z') });
    expect(res.updated).toBe(0);
    expect(updates).toHaveLength(0);
  });
});
