/**
 * F-055 — normalizeChapters の単体テスト。ユーザー報告の二重番号バグを再現し修正を担保。
 */
import { describe, expect, it } from 'vitest';

import { normalizeChapters, formatChapterTitle } from '../src/book/chapter-title.js';

describe('normalizeChapters — 二重番号/前書き後書きの正規化', () => {
  it('報告例: はじめに→intro、本文→第1..8章、おわりに→outro に正しく整える', () => {
    const input = [
      { index: 1, heading: '第1章: はじめに——「頑張らない貯金」が最強の理由' },
      { index: 2, heading: '第1章　デスク・部屋を変える——視界から「浪費スイッチ」をなくす' },
      { index: 3, heading: '第2章　財布・スマホを変える——「払いやすさ」を意図的に下げる' },
      { index: 4, heading: '第3章　冷蔵庫・キッチンを変える——「食費爆弾」を仕組みで解体する' },
      { index: 5, heading: '第4章　口座・アプリを変える——「先取り貯蓄」を自動化する仕組み' },
      { index: 6, heading: '第5章　時間・ルーティンを変える——「買う気になりやすい時間帯」を避ける' },
      { index: 7, heading: '第6章　人間関係・情報環境を変える——「見えない同調圧力」を断つ' },
      { index: 8, heading: '第7章　固定費・サブスクを変える——毎月自動で削れる「最強の節約」' },
      { index: 9, heading: '第8章　習慣を定着させる——100のチェックリストを「続く仕組み」に変える' },
      { index: 10, heading: '第10章: おわりに——環境が変われば、未来が変わる' },
    ];
    const out = normalizeChapters(input);

    expect(out.map((c) => c.kind)).toEqual([
      'intro', 'body', 'body', 'body', 'body', 'body', 'body', 'body', 'body', 'outro',
    ]);
    // 本文は 1..8 に振り直し
    expect(out.filter((c) => c.kind === 'body').map((c) => c.bodyNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // 二重番号が消える
    expect(out[0]!.titleLine).toBe('はじめに——「頑張らない貯金」が最強の理由');
    expect(out[1]!.titleLine).toBe('第1章　デスク・部屋を変える——視界から「浪費スイッチ」をなくす');
    expect(out[8]!.titleLine).toBe('第8章　習慣を定着させる——100のチェックリストを「続く仕組み」に変える');
    expect(out[9]!.titleLine).toBe('おわりに——環境が変われば、未来が変わる');
    // どのタイトル行にも「第N章: 第M章」の二重は無い
    for (const c of out) expect(c.titleLine).not.toMatch(/第\s*\d+\s*章.*第\s*\d+\s*章/);
  });

  it('番号なしのクリーンな見出しはそのまま body 連番を振る', () => {
    const out = normalizeChapters([
      { index: 1, heading: 'デスクを片付ける' },
      { index: 2, heading: '財布を軽くする' },
    ]);
    expect(out[0]!.titleLine).toBe('第1章　デスクを片付ける');
    expect(out[1]!.titleLine).toBe('第2章　財布を軽くする');
  });

  it('全角数字・Chapter 表記の先頭番号も剥がす', () => {
    expect(normalizeChapters([{ index: 1, heading: '第１章：やる気の科学' }])[0]!.titleLine).toBe('第1章　やる気の科学');
    expect(normalizeChapters([{ index: 1, heading: 'Chapter 3: Focus' }])[0]!.titleLine).toBe('第1章　Focus');
  });

  it('formatChapterTitle 単体版: intro は番号を付けない', () => {
    expect(formatChapterTitle(1, '第1章 はじめに')).toBe('はじめに');
    expect(formatChapterTitle(2, '第5章 本題です')).toBe('第2章　本題です');
  });
});
