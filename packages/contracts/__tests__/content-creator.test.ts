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
    expect(AccountContentOutputSchema.safeParse({ posts: [] }).success).toBe(false);
    expect(AccountContentOutputSchema.safeParse({ posts: [{ pillar: '', body: 'x' }] }).success).toBe(false);
  });
});
