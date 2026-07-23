/**
 * composePromoCreative の回帰テスト。
 * - 出力が 1080×1350 (4:5) の妥当な JPEG であること。
 * - 過去に opentype.js の非整数 baseline で NaN パス→librsvg が描画を落とす不具合が
 *   あった見出しでもクラッシュ/空画像にならないこと（linePathLeft の整数丸めで回避）。
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { composePromoCreative, promoAccent } from '../src/compose-promo.js';

async function solid(w: number, h: number, r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();
}

describe('composePromoCreative', () => {
  const cases = [
    '9割が損してる「お金の口ぐせ」。1日3分で見直すだけ',
    'いい人ほど、なぜか人生詰む。', // かつて NaN を誘発した見出し
    '短い見出し',
  ];

  for (const headline of cases) {
    it(`4:5 の妥当な JPEG を生成する: "${headline.slice(0, 12)}…"`, async () => {
      const bg = await solid(1080, 1350, 20, 36, 46);
      const cover = await solid(1600, 2560, 200, 170, 100);
      const out = await composePromoCreative(
        bg,
        cover,
        { badge: '新刊', ku: 'KU 読み放題', headline, title: 'サンプル書名', eyebrow: '想定読者へ', cta: 'プロフィールのリンクから' },
        { accent: promoAccent('money') },
      );
      expect(out.byteLength).toBeGreaterThan(5000);
      const meta = await sharp(out).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(1080);
      expect(meta.height).toBe(1350);
    });
  }

  it('promoAccent はジャンルで色を返し、未知はゴールド', () => {
    expect(promoAccent('money')).toBe('#e0b23a');
    expect(promoAccent(null)).toBe('#e0a83a');
    expect(promoAccent('unknown_genre')).toBe('#e0a83a');
  });
});
