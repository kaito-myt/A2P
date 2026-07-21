/**
 * F-060 — TikTok 動画スキーマの単体テスト。
 */
import { describe, expect, it } from 'vitest';

import {
  TikTokVideoInputSchema,
  VideoScenarioSchema,
  VideoScriptSchema,
} from '../src/agents/tiktok-video.js';

describe('TikTokVideoInputSchema', () => {
  it('topic 必須・channel/target 既定', () => {
    const res = TikTokVideoInputSchema.safeParse({ topic: 'がんばらない働き方' });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.channel).toBe('tiktok');
      expect(res.data.target_seconds).toBe(30);
    }
  });
  it('topic 欠落は不合格', () => {
    expect(TikTokVideoInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('VideoScenarioSchema', () => {
  it('hook/beats/cliffhanger を検証', () => {
    const ok = VideoScenarioSchema.safeParse({
      hook: '9割が知らない',
      beats: [
        { role: 'hook', narration: '実は…' },
        { role: 'reveal', narration: '答えは…' },
      ],
      cliffhanger: '続きはプロフィールへ',
    });
    expect(ok.success).toBe(true);
    // beats 1本は不合格(min 2)
    expect(
      VideoScenarioSchema.safeParse({ hook: 'x', beats: [{ role: 'hook', narration: 'a' }], cliffhanger: 'c' }).success,
    ).toBe(false);
  });
});

describe('VideoScriptSchema', () => {
  const scene = { narration: 'ナレーション', caption: 'テロップ', image_prompt: '背景', seconds: 3 };
  it('scenes/caption/hashtags を検証', () => {
    const ok = VideoScriptSchema.safeParse({
      title: 'タイトル',
      scenes: [scene, scene],
      caption: '続きが気になる本文',
      hashtags: ['#仕事術'],
    });
    expect(ok.success).toBe(true);
  });
  it('scene 1本は不合格(min 2)', () => {
    expect(
      VideoScriptSchema.safeParse({ title: 't', scenes: [scene], caption: 'c', hashtags: [] }).success,
    ).toBe(false);
  });
  it('caption 60字超は不合格', () => {
    const bad = { ...scene, caption: 'あ'.repeat(61) };
    expect(
      VideoScriptSchema.safeParse({ title: 't', scenes: [bad, bad], caption: 'c', hashtags: [] }).success,
    ).toBe(false);
  });
});
