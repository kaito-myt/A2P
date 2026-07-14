import { describe, expect, it } from 'vitest';

import { sanitizeLlmJson, extractLlmJson } from '../src/lib/sanitize-llm-json.js';

describe('sanitizeLlmJson', () => {
  it('有効な JSON は変更しない（冪等）', () => {
    const s = '{"a":"b","n":1,"arr":["x","y"],"esc":"quote \\" here"}';
    expect(JSON.parse(sanitizeLlmJson(s))).toEqual(JSON.parse(s));
  });

  it('文字列値内の未エスケープ二重引用符を修復する', () => {
    // 実際に thumbnail_text が落ちたパターン
    const broken = '{"subtitle": "平安の"陽キャ"がSNS全開で語る枕草子"}';
    const fixed = JSON.parse(sanitizeLlmJson(broken));
    expect(fixed.subtitle).toBe('平安の"陽キャ"がSNS全開で語る枕草子');
  });

  it('文字列値内の生改行/タブをエスケープする', () => {
    const broken = '{"body": "line1\nline2\ttabbed"}';
    const fixed = JSON.parse(sanitizeLlmJson(broken));
    expect(fixed.body).toBe('line1\nline2\ttabbed');
  });

  it('複数フィールド＋末尾の引用符も構造として正しく閉じる', () => {
    const broken = '{"title":"バズりたい女","band_copy":"「春はあけぼの」って要は"映え"の話","n":2}';
    const fixed = JSON.parse(sanitizeLlmJson(broken));
    expect(fixed.title).toBe('バズりたい女');
    expect(fixed.band_copy).toBe('「春はあけぼの」って要は"映え"の話');
    expect(fixed.n).toBe(2);
  });
});

describe('extractLlmJson', () => {
  it('前置きの散文＋未エスケープ引用符があっても抽出できる', () => {
    const raw =
      'リサーチ結果をもとに提案します。\n\n{"directions":[{"concept":"平安の"陽キャ"路線","image_prompt":"anime cover"}]}';
    const out = extractLlmJson<{ directions: Array<{ concept: string; image_prompt: string }> }>(raw);
    expect(out?.directions?.[0]?.image_prompt).toBe('anime cover');
    expect(out?.directions?.[0]?.concept).toContain('陽キャ');
  });

  it('```json フェンス内を優先的に取り出す', () => {
    const raw = 'ここに提案:\n```json\n{"proposals":[{"title":"本"}]}\n```\n以上です';
    const out = extractLlmJson<{ proposals: Array<{ title: string }> }>(raw, (p) =>
      Boolean((p as { proposals?: unknown[] })?.proposals),
    );
    expect(out?.proposals?.[0]?.title).toBe('本');
  });

  it('パース不能なら undefined', () => {
    expect(extractLlmJson('これはただの文章です。JSONはありません。')).toBeUndefined();
    expect(extractLlmJson('')).toBeUndefined();
  });
});
