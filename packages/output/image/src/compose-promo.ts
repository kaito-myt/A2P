/**
 * IG/SNS 販促クリエイティブ合成（デザイン販促型・v2）。
 *
 * docs/08-promo-playbook.md の「売れる型」に準拠:
 *   - ベネフィット見出しが主役（最大要素・上部）。表紙は"証拠"として小さく下部に。
 *   - 4:5（1080×1350）でフィード占有面積を最大化。上下 ~120px はセーフゾーン。
 *   - 数字はアクセント色で強調（権威づけ・スクロール停止）。
 *   - 「新刊 / KU 読み放題」バッジで即時ゼロリスク訴求。
 *   - アクセントは1色（ジャンル別）。高コントラスト（白見出し＋暗ハロー）。
 *   - CTA ボタンでプロフィールリンクへ誘導。
 *
 * 文字はすべて Noto Sans JP のグリフアウトライン(SVG path)で合成するため、
 * 生成AI特有の文字化けは一切起きない（compose-cover と同方式）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import opentype from 'opentype.js';

const REGULAR_FONT_PATH = fileURLToPath(
  new URL('../assets/fonts/NotoSansJP-Regular.ttf', import.meta.url),
);
const BOLD_FONT_PATH = fileURLToPath(
  new URL('../assets/fonts/NotoSansJP-Bold.ttf', import.meta.url),
);

let regularFont: opentype.Font | null = null;
let boldFont: opentype.Font | null = null;

function loadFont(path: string): opentype.Font {
  const buf = readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return opentype.parse(ab);
}
function loadFonts(): { regular: opentype.Font; bold: opentype.Font } {
  if (!regularFont) regularFont = loadFont(REGULAR_FONT_PATH);
  if (!boldFont) boldFont = loadFont(BOLD_FONT_PATH);
  return { regular: regularFont, bold: boldFont };
}

function wrapByWidth(font: opentype.Font, text: string, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of Array.from(text)) {
    if (ch === '\n') { lines.push(cur); cur = ''; continue; }
    const test = cur + ch;
    if (cur.length > 0 && font.getAdvanceWidth(test, fontSize) > maxWidth) {
      lines.push(cur);
      cur = ch;
    } else {
      cur = test;
    }
  }
  if (cur.length > 0) lines.push(cur);
  return lines;
}

/** maxLines 以内に収まる最大フォントサイズを探す。 */
function fitText(
  font: opentype.Font,
  text: string,
  maxWidth: number,
  startSize: number,
  minSize: number,
  maxLines: number,
): { size: number; lines: string[] } {
  let size = startSize;
  let lines = wrapByWidth(font, text, size, maxWidth);
  while (lines.length > maxLines && size > minSize) {
    size -= Math.max(2, Math.round(size * 0.06));
    lines = wrapByWidth(font, text, size, maxWidth);
  }
  return { size, lines };
}

function linePathLeft(font: opentype.Font, text: string, size: number, x: number, baseline: number): string {
  // opentype.js は非整数の baseline で稀に NaN 座標のパスを生成する（librsvg が黙って
  // 描画を落とす）。整数に丸めて回避する。
  return font.getPath(text, Math.round(x), Math.round(baseline), Math.round(size)).toPathData(2);
}

/** 数字＋単位(万円%割倍位個歳日年時分秒人)の連なりを検出して強調用に分割する。 */
const NUM_RE = /([0-9０-９]+(?:[.,．][0-9０-９]+)?[万億円%％割倍位個歳日年月週時間分秒人本冊倍]*)/;
function splitNumberRuns(line: string): { text: string; num: boolean }[] {
  const out: { text: string; num: boolean }[] = [];
  let rest = line;
  while (rest.length > 0) {
    const m = NUM_RE.exec(rest);
    const g = m?.[1];
    if (!m || m.index === undefined || g === undefined) { out.push({ text: rest, num: false }); break; }
    if (m.index > 0) out.push({ text: rest.slice(0, m.index), num: false });
    out.push({ text: g, num: true });
    rest = rest.slice(m.index + g.length);
  }
  return out;
}

/** 1行を描画。数字ランはアクセント色、それ以外は白。暗ハロー付き。 */
function drawHeadlineLine(
  bold: opentype.Font,
  line: string,
  size: number,
  x: number,
  baseline: number,
  accent: string,
): string {
  const runs = splitNumberRuns(line);
  let cx = x;
  const halo: string[] = [];
  const fill: string[] = [];
  for (const r of runs) {
    if (r.text.length === 0) continue;
    const d = linePathLeft(bold, r.text, size, cx, baseline);
    halo.push(`<path d="${d}" fill="none" stroke="#0a0a0a" stroke-width="${(size * 0.10).toFixed(1)}" stroke-linejoin="round" opacity="0.6"/>`);
    fill.push(`<path d="${d}" fill="${r.num ? accent : '#ffffff'}"/>`);
    cx += bold.getAdvanceWidth(r.text, size);
  }
  return [...halo, ...fill].join('');
}

export interface PromoContent {
  /** 例: 新刊 */
  badge: string;
  /** 例: KU 読み放題 */
  ku: string;
  /** ベネフィット見出し（本のフック）。主役。長くても自動で収める。 */
  headline: string;
  /** 書名。 */
  title: string;
  /** 例: 〜な人へ（想定読者・任意）。 */
  eyebrow?: string;
  /** 例: プロフィールのリンクから */
  cta: string;
}

export interface PromoOptions {
  /** アクセント色（バッジ/CTA/数字/下線）。 */
  accent?: string;
}

/** ジャンル → アクセント色。未知は暖色ゴールド。 */
export function promoAccent(genre: string | null | undefined): string {
  const map: Record<string, string> = {
    business: '#e0a83a', money: '#e0b23a', money_saving: '#4bb07a', side_business: '#e0913a',
    career: '#4b8fd0', marketing: '#e05c8a',
    self_help: '#f0a83a', mental: '#7aa6d0', communication: '#4bb0a6', relationship: '#e07a9a', habit: '#e0913a',
    practical: '#f0a04b', health: '#4bb07a', diet: '#5cc07a', cooking: '#e0703a', lifestyle: '#d0a05a',
    parenting: '#f0a860', beauty: '#e07a9a', pet: '#d0954b',
    study: '#4b8fd0', language: '#4bb0a6', writing: '#c88fd0', it_web: '#4b8fd0', ai_tech: '#5c9fe0',
    hobby: '#e0913a', gambling: '#e0b23a', travel: '#4bb0c0', spiritual: '#a86fd0', history: '#c0954b',
  };
  return (genre && map[genre]) || '#e0a83a';
}

/**
 * 背景画像・実表紙・文言から、1080×1350(4:5) の販促クリエイティブ(JPEG)を合成する。
 * ベネフィット見出しを主役に、表紙は下部の"証拠"として配置する。
 */
export async function composePromoCreative(
  bg: Buffer,
  cover: Buffer,
  content: PromoContent,
  opts: PromoOptions = {},
): Promise<Buffer> {
  const { regular, bold } = loadFonts();
  const W = 1080;
  const H = 1350;
  const M = 76; // 左右マージン
  const accent = opts.accent ?? '#e0a83a';

  // --- 背景を 1080×1350 にカバー ---
  const base = sharp(bg).resize(W, H, { fit: 'cover', position: 'centre' });

  // --- 下部: 表紙(証拠)。高さ基準でリサイズ ---
  const coverMeta = await sharp(cover).metadata();
  const cw = coverMeta.width ?? 1600;
  const ch = coverMeta.height ?? 2560;
  let coverH = 470;
  let coverW = Math.round(coverH * (cw / ch));
  const maxCoverW = 320;
  if (coverW > maxCoverW) { coverW = maxCoverW; coverH = Math.round(coverW * (ch / cw)); }
  const ctaH = 84;
  const bottomSafe = 116;
  const ctaY = H - bottomSafe - ctaH;
  const coverGap = 40;
  const coverTop = ctaY - coverGap - coverH;
  const coverLeft = M;
  const coverBuf = await sharp(cover).resize(coverW, coverH, { fit: 'fill' }).png().toBuffer();

  // タイトル列（表紙の右）
  const titleX = coverLeft + coverW + 40;
  const titleW = W - titleX - M;

  // ============ レイヤ1: スクリム＋ビネット＋表紙の影 ============
  const scrimSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="vg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#080b11" stop-opacity="0.42"/>
        <stop offset="0.42" stop-color="#080b11" stop-opacity="0.30"/>
        <stop offset="0.78" stop-color="#080b11" stop-opacity="0.66"/>
        <stop offset="1" stop-color="#05070b" stop-opacity="0.86"/>
      </linearGradient>
      <filter id="sh" x="-25%" y="-25%" width="150%" height="150%">
        <feGaussianBlur stdDeviation="20"/>
      </filter>
    </defs>
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#vg)"/>
    <rect x="${coverLeft + 16}" y="${coverTop + 24}" width="${coverW}" height="${coverH}" rx="10" fill="#04060a" opacity="0.6" filter="url(#sh)"/>
  </svg>`;

  // ============ レイヤ3: バッジ・見出し・タイトル・CTA ============
  const parts: string[] = [];

  // --- バッジ（新刊 / KU） 上部セーフゾーン直下 ---
  const badgeText = content.badge.trim();
  const kuText = content.ku.trim();
  const badgeSize = 32;
  const badgePadX = 24;
  const badgeH = 64;
  const badgeGap = 14;
  const badgeY = 120;
  const badge1W = bold.getAdvanceWidth(badgeText, badgeSize) + badgePadX * 2;
  const badge2W = regular.getAdvanceWidth(kuText, badgeSize) + badgePadX * 2;
  parts.push(`<rect x="${M}" y="${badgeY}" width="${badge1W.toFixed(0)}" height="${badgeH}" rx="${badgeH / 2}" fill="${accent}"/>`);
  parts.push(`<path d="${linePathLeft(bold, badgeText, badgeSize, M + badgePadX, badgeY + badgeH / 2 + badgeSize * 0.34)}" fill="#1a1206"/>`);
  if (kuText) {
    const kx = M + badge1W + badgeGap;
    parts.push(`<rect x="${kx.toFixed(0)}" y="${badgeY}" width="${badge2W.toFixed(0)}" height="${badgeH}" rx="${badgeH / 2}" fill="#0b0e14" opacity="0.62"/>`);
    parts.push(`<rect x="${kx.toFixed(0)}" y="${badgeY}" width="${badge2W.toFixed(0)}" height="${badgeH}" rx="${badgeH / 2}" fill="none" stroke="${accent}" stroke-width="2.5"/>`);
    parts.push(`<path d="${linePathLeft(regular, kuText, badgeSize, kx + badgePadX, badgeY + badgeH / 2 + badgeSize * 0.34)}" fill="#ffffff"/>`);
  }

  // --- eyebrow（想定読者・任意） ---
  const eyebrow = content.eyebrow?.trim();
  let y = badgeY + badgeH + 54;
  if (eyebrow) {
    const eSize = 34;
    for (const ln of wrapByWidth(regular, eyebrow, eSize, W - 2 * M).slice(0, 2)) {
      const baseline = y + eSize * 0.82;
      parts.push(`<path d="${linePathLeft(regular, ln, eSize, M, baseline)}" fill="${accent}"/>`);
      y += eSize * 1.3;
    }
    y += 18;
  }

  // --- 見出し（主役・ベネフィット）。上部領域(表紙の上まで)に大きく収める ---
  const headlineMaxH = coverTop - 40 - y;
  const hlWidth = W - 2 * M;
  let { size: hlSize, lines: hlLines } = fitText(bold, content.headline.trim(), hlWidth, 116, 52, 5);
  let hlLH = hlSize * 1.24;
  // 縦にも収める（行数×行高が領域を超えたら縮小）
  while (hlLines.length * hlLH > headlineMaxH && hlSize > 46) {
    hlSize -= 3;
    hlLines = wrapByWidth(bold, content.headline.trim(), hlSize, hlWidth);
    hlLH = hlSize * 1.24;
  }
  for (const ln of hlLines) {
    const baseline = y + hlSize * 0.80;
    parts.push(drawHeadlineLine(bold, ln, hlSize, M, baseline, accent));
    y += hlLH;
  }
  // アクセント下線
  y += 10;
  parts.push(`<rect x="${M}" y="${Math.min(y, coverTop - 24).toFixed(0)}" width="96" height="7" rx="3.5" fill="${accent}"/>`);

  // --- タイトル（表紙の右・下部帯） ---
  const titleSize = 36;
  const titleLines = wrapByWidth(bold, content.title.trim(), titleSize, titleW).slice(0, 4);
  const titleLH = titleSize * 1.32;
  const titleBlockH = titleLines.length * titleLH;
  let ty = coverTop + Math.max(0, (coverH - titleBlockH) / 2);
  // タイトル上に小さなアクセントのラベル線
  parts.push(`<rect x="${titleX}" y="${(ty - 22).toFixed(0)}" width="40" height="5" rx="2.5" fill="${accent}"/>`);
  for (const ln of titleLines) {
    const baseline = ty + titleSize * 0.82;
    const d = linePathLeft(bold, ln, titleSize, titleX, baseline);
    parts.push(`<path d="${d}" fill="none" stroke="#0a0a0a" stroke-width="${(titleSize * 0.08).toFixed(1)}" stroke-linejoin="round" opacity="0.5"/>`);
    parts.push(`<path d="${d}" fill="#f3eee3"/>`);
    ty += titleLH;
  }

  // --- CTA（下部・全幅） ---
  const ctaText = content.cta.trim();
  const ctaX = M;
  const ctaW = W - 2 * M;
  const triW = 22;
  const triGap = 16;
  let ctaSize = 36;
  while (ctaSize > 22 && triW + triGap + bold.getAdvanceWidth(ctaText, ctaSize) > ctaW - 48) ctaSize -= 2;
  const ctaGroupW = triW + triGap + bold.getAdvanceWidth(ctaText, ctaSize);
  const ctaGroupX = ctaX + (ctaW - ctaGroupW) / 2;
  const ctaMidY = ctaY + ctaH / 2;
  parts.push(`<rect x="${ctaX}" y="${ctaY}" width="${ctaW}" height="${ctaH}" rx="16" fill="${accent}"/>`);
  parts.push(`<polygon points="${ctaGroupX},${(ctaMidY - 12).toFixed(1)} ${ctaGroupX + triW},${ctaMidY.toFixed(1)} ${ctaGroupX},${(ctaMidY + 12).toFixed(1)}" fill="#1a1206"/>`);
  parts.push(`<path d="${linePathLeft(bold, ctaText, ctaSize, ctaGroupX + triW + triGap, ctaMidY + ctaSize * 0.34)}" fill="#1a1206"/>`);

  const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`;

  const out = await base
    .composite([
      { input: Buffer.from(scrimSvg), top: 0, left: 0 },
      { input: coverBuf, top: coverTop, left: coverLeft },
      { input: Buffer.from(textSvg), top: 0, left: 0 },
    ])
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();

  return out;
}
