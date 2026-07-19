/**
 * F-057 — AccountStrategyProfile / SnsStrategistInput スキーマの単体テスト。
 */
import { describe, expect, it } from 'vitest';

import {
  AccountStrategyProfileSchema,
  SnsStrategistInputSchema,
} from '../src/agents/sns-strategist.js';

function validProfile() {
  return {
    concept: '毎朝1つ、明日から使える仕事術',
    display_name: '仕事術ラボ',
    handle_suggestion: 'shigoto_lab',
    bio: '忙しい20〜30代へ、明日から使える仕事術を毎朝ひとつ。',
    content_pillars: [
      { name: '時短術', description: '無駄を1つ削る', example_post: 'メール返信は1日3回に。' },
      { name: '思考整理', description: '頭を軽くする問い', example_post: '朝に3回問う。' },
      { name: '習慣化', description: '続く仕組み', example_post: '既存習慣の直後に置く。' },
    ],
    tone_of_voice: '敬体・絵文字控えめ',
    posting_cadence: { frequency: '平日1日1投稿', best_times: ['07:30'] },
    hashtag_strategy: { core: ['#仕事術'], rotating: ['#朝活'] },
    growth_tactics: ['朝に投稿', 'スレッドで深掘り'],
    avatar_prompt: '朝日のアイコン',
    banner_prompt: 'デスクの俯瞰',
  };
}

describe('AccountStrategyProfileSchema', () => {
  it('妥当なプロファイルを受理する', () => {
    const res = AccountStrategyProfileSchema.safeParse(validProfile());
    expect(res.success).toBe(true);
  });

  it('content_pillars が3本未満なら不合格', () => {
    const bad = { ...validProfile(), content_pillars: validProfile().content_pillars.slice(0, 2) };
    expect(AccountStrategyProfileSchema.safeParse(bad).success).toBe(false);
  });

  it('growth_tactics が2個未満なら不合格', () => {
    const bad = { ...validProfile(), growth_tactics: ['ひとつだけ'] };
    expect(AccountStrategyProfileSchema.safeParse(bad).success).toBe(false);
  });

  it('rationale は任意', () => {
    const withR = { ...validProfile(), rationale: '根拠' };
    expect(AccountStrategyProfileSchema.safeParse(withR).success).toBe(true);
  });
});

describe('SnsStrategistInputSchema', () => {
  it('channel + catalog で受理し、catalog の既定を埋める', () => {
    const res = SnsStrategistInputSchema.safeParse({
      channel: 'x',
      catalog: {},
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.catalog.genre_inventory).toEqual({});
      expect(res.data.catalog.sample_titles).toEqual([]);
    }
  });

  it('不正な channel は不合格', () => {
    expect(
      SnsStrategistInputSchema.safeParse({ channel: 'sns', catalog: {} }).success,
    ).toBe(false);
  });
});
