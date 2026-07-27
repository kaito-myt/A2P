/**
 * extractOtpCode / processLineEvents — LINE 双方向認証リレーの純粋ロジックテスト。
 */
import { describe, expect, it, vi } from 'vitest';

import { extractOtpCode, processLineEvents, type LineEvent } from '@/lib/line-webhook-core';

describe('extractOtpCode', () => {
  it('プレーンな 6 桁 → そのまま抽出', () => {
    expect(extractOtpCode('123456')).toBe('123456');
  });

  it('スペース区切り "123 456" → "123456"', () => {
    expect(extractOtpCode('123 456')).toBe('123456');
  });

  it('ハイフン区切り "123-456" → "123456"', () => {
    expect(extractOtpCode('123-456')).toBe('123456');
  });

  it('文中に埋め込み → 抽出できる', () => {
    expect(extractOtpCode('認証コードは 123456 です')).toBe('123456');
  });

  it('5 桁 (不足) → null', () => {
    expect(extractOtpCode('12345')).toBeNull();
  });

  it('7 桁 (超過) → null', () => {
    expect(extractOtpCode('1234567')).toBeNull();
  });

  it('数字なし → null', () => {
    expect(extractOtpCode('こんにちは')).toBeNull();
  });
});

const ALLOWED = 'U_operator';

function makeDeps(overrides?: Partial<Parameters<typeof processLineEvents>[1]>) {
  return {
    allowedUserId: ALLOWED,
    now: new Date('2026-07-27T00:00:00Z'),
    findPending: vi.fn(async () => ({ id: 'req_1' })),
    fulfill: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('processLineEvents', () => {
  it('コードあり + pending あり → fulfill してから受付メッセージを返信', async () => {
    const deps = makeDeps();
    const events: LineEvent[] = [
      {
        type: 'message',
        message: { type: 'text', text: '123456' },
        source: { userId: ALLOWED },
        replyToken: 'tok_1',
      },
    ];
    await processLineEvents(events, deps);

    expect(deps.fulfill).toHaveBeenCalledWith('req_1', '123456');
    expect(deps.reply).toHaveBeenCalledWith(
      'tok_1',
      '✅ 認証コードを受け付けました。ツールが自動で入力します。',
    );
  });

  it('許可されていないユーザー → 完全に無視 (返信もしない)', async () => {
    const deps = makeDeps();
    const events: LineEvent[] = [
      {
        type: 'message',
        message: { type: 'text', text: '123456' },
        source: { userId: 'someone_else' },
        replyToken: 'tok_2',
      },
    ];
    await processLineEvents(events, deps);

    expect(deps.fulfill).not.toHaveBeenCalled();
    expect(deps.reply).not.toHaveBeenCalled();
  });

  it('コードあり + pending なし → 「認証待ちなし」メッセージ', async () => {
    const deps = makeDeps({ findPending: vi.fn(async () => null) });
    const events: LineEvent[] = [
      {
        type: 'message',
        message: { type: 'text', text: '123456' },
        source: { userId: ALLOWED },
        replyToken: 'tok_3',
      },
    ];
    await processLineEvents(events, deps);

    expect(deps.fulfill).not.toHaveBeenCalled();
    expect(deps.reply).toHaveBeenCalledWith(
      'tok_3',
      '現在、認証待ちのリクエストはありません。',
    );
  });

  it('6 桁コードが本文にない → 「6桁を送って」メッセージ', async () => {
    const deps = makeDeps();
    const events: LineEvent[] = [
      {
        type: 'message',
        message: { type: 'text', text: 'こんにちは' },
        source: { userId: ALLOWED },
        replyToken: 'tok_4',
      },
    ];
    await processLineEvents(events, deps);

    expect(deps.findPending).not.toHaveBeenCalled();
    expect(deps.fulfill).not.toHaveBeenCalled();
    expect(deps.reply).toHaveBeenCalledWith('tok_4', '6桁の認証コードを送ってください。');
  });

  it('message 以外の type / text 以外の message は無視', async () => {
    const deps = makeDeps();
    const events: LineEvent[] = [
      { type: 'follow', source: { userId: ALLOWED }, replyToken: 'tok_5' },
      {
        type: 'message',
        message: { type: 'sticker' },
        source: { userId: ALLOWED },
        replyToken: 'tok_6',
      },
    ];
    await processLineEvents(events, deps);

    expect(deps.reply).not.toHaveBeenCalled();
    expect(deps.fulfill).not.toHaveBeenCalled();
  });

  it('replyToken がない場合は返信を試みない', async () => {
    const deps = makeDeps();
    const events: LineEvent[] = [
      { type: 'message', message: { type: 'text', text: 'hi' }, source: { userId: ALLOWED } },
    ];
    await processLineEvents(events, deps);

    expect(deps.reply).not.toHaveBeenCalled();
  });
});
