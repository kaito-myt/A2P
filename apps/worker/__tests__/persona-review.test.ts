import { describe, it, expect, vi } from 'vitest';

import { reviewDraftsWithPersona, pillarStrings } from '../src/tasks/promotion-post/persona-review.js';
import type { AccountStrategyProfile } from '@a2p/contracts/agents';

function profile(overrides: Partial<AccountStrategyProfile> = {}): AccountStrategyProfile {
  return {
    concept: '副業で稼ぐ実践知を届けるアカウント',
    display_name: '副業ラボ',
    handle_suggestion: 'fukugyo_lab',
    bio: '会社員の副業を後押し',
    content_pillars: [{ name: '副業の始め方', description: '初月にやること' }],
    tone_of_voice: '親しみやすく具体的',
    posting_cadence: { frequency: 'daily', best_times: ['21:00'] },
    hashtag_strategy: { core: ['#副業'], rotating: [] },
    growth_tactics: ['フック型の投稿'],
    avatar_prompt: 'x',
    banner_prompt: 'y',
    ...overrides,
  } as AccountStrategyProfile;
}

describe('pillarStrings', () => {
  it('name: description の文字列にする', () => {
    expect(pillarStrings(profile())).toEqual(['副業の始め方: 初月にやること']);
  });
});

describe('reviewDraftsWithPersona', () => {
  it('optimize が改善を返せば採用し、score/reason を記録する', async () => {
    const optimize = vi.fn(async () => ({
      revisions: [{ id: 'd1', changed: true, revised_body: '改善版', reason: 'r', score: 88, on_strategy: true, persona_reaction: '刺さる' }],
    }));
    const res = await reviewDraftsWithPersona({
      channel: 'x',
      profile: profile(),
      drafts: [{ id: 'd1', kind: 'value', body: '元本文' }],
      optimize,
    });
    expect(res.get('d1')).toEqual({ body: '改善版', score: 88, reason: '刺さる', changed: true });
    // 戦略/ペルソナが optimize に渡っている
    const arg = optimize.mock.calls[0]![0];
    expect(arg.content_pillars.length).toBeGreaterThan(0);
    expect(arg.persona).toContain('副業');
  });

  it('promo で URL が落ちる改善は破棄し原文据え置き', async () => {
    const url = 'https://www.amazon.co.jp/dp/XXXX';
    const optimize = vi.fn(async () => ({
      revisions: [{ id: 'd1', changed: true, revised_body: 'URL消した本文', reason: '', score: 70, on_strategy: true, persona_reaction: '' }],
    }));
    const res = await reviewDraftsWithPersona({
      channel: 'x',
      profile: profile(),
      drafts: [{ id: 'd1', kind: 'promo', body: `新刊 ${url}` }],
      optimize,
    });
    expect(res.get('d1')!.body).toBe(`新刊 ${url}`); // 原文据え置き
    expect(res.get('d1')!.changed).toBe(false);
    expect(res.get('d1')!.score).toBe(70); // スコアは記録
  });

  it('optimize 失敗時は原文据え置き(スロー無し)', async () => {
    const optimize = vi.fn(async () => { throw new Error('llm down'); });
    const res = await reviewDraftsWithPersona({
      channel: 'x',
      profile: profile(),
      drafts: [{ id: 'd1', kind: 'value', body: '元本文' }],
      optimize,
    });
    expect(res.get('d1')).toEqual({ body: '元本文', score: null, reason: null, changed: false });
  });
});
