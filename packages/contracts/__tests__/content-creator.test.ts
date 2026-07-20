/**
 * F-059 — content_creator I/O スキーマの単体テスト。
 */
import { describe, expect, it } from 'vitest';

import {
  ContentCreatorInputSchema,
  AccountContentOutputSchema,
} from '../src/agents/content-creator.js';

describe('ContentCreatorInputSchema', () => {
  it('pillars 必須・既定値を埋める', () => {
    const res = ContentCreatorInputSchema.safeParse({
      channel: 'x',
      pillars: [{ name: '時短術' }],
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.count).toBe(8);
      expect(res.data.pillars[0]!.description).toBe('');
    }
  });
  it('pillars 空は不合格', () => {
    expect(ContentCreatorInputSchema.safeParse({ channel: 'x', pillars: [] }).success).toBe(false);
  });
  it('不正 channel は不合格', () => {
    expect(ContentCreatorInputSchema.safeParse({ channel: 'sns', pillars: [{ name: 'a' }] }).success).toBe(false);
  });
});

describe('AccountContentOutputSchema', () => {
  it('posts を検証する', () => {
    const ok = AccountContentOutputSchema.safeParse({ posts: [{ pillar: '時短術', body: 'メールは1日3回に。' }] });
    expect(ok.success).toBe(true);
    // 空配列は不合格
    expect(AccountContentOutputSchema.safeParse({ posts: [] }).success).toBe(false);
    // body 空は除外され posts が空 → 不合格
    expect(AccountContentOutputSchema.safeParse({ posts: [{ pillar: 'a', body: '' }] }).success).toBe(false);
  });

  it('ゆらぎ吸収: トップ配列 / pillar欠落 / body別名 を正規化する', () => {
    // posts をトップ配列で返す
    const a = AccountContentOutputSchema.safeParse([{ body: 'メールは1日3回に。' }]);
    expect(a.success).toBe(true);
    if (a.success) expect(a.data.posts[0]!.pillar).toBe('一般'); // pillar欠落→'一般'
    // body の別名(text)も拾う
    const b = AccountContentOutputSchema.safeParse({ posts: [{ pillar: '時短', text: '朝に3回問う。' }] });
    expect(b.success).toBe(true);
    if (b.success) expect(b.data.posts[0]!.body).toBe('朝に3回問う。');
  });
});
