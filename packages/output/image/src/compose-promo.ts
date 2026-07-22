/**
 * IG/SNS 販促クリエイティブ合成（デザイン販促型）。
 *
 * リサーチ（売れるKindle販促の原則）に基づく構成:
 *   - 実際の表紙を主役に据える（本の一番の販売資産）
 *   - 「新刊 / KU会員は無料」バッジで即時ベネフィット
 *   - 太いベネフィット見出し（本のフック）を3秒で伝える
 *   - タイトル＋CTA（プロフィールのリンクへ誘導）
 *   - 白背景を避け、ジャンル別アクセント配色
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

/** 左寄せ1行を baseline に配置し path data を返す。 */
function linePathLeft(font: opentype.Font, text: string, size: number, x: number, baseline: number): string {
  return font.getPath(text, x, baseline, size).toPathData(2);
}

export interface PromoContent {
  /** 例: 新刊 */
  badge: string;
  /** 例: KU会員は無料 */
  ku: string;
  /** ベネフィット見出し（本のフック）。長くても自動で収める。 */
  headline: string;
  /** 書名。 */
  title: string;
  /** 例: 〜な人へ（想定読者・任意）。 */
  eyebrow?: string;
  /** 例: プロフィールのリンクから */
  cta: string;
}

export interface PromoOptions {
  /** アクセント色（バッジ/CTA/見出しアクセント）。 */
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
 * 背景画像・実表紙・文言から、1080×1080 の販促クリエイティブ(JPEG)を合成する。
 *
 * @param bg     背景画像 buffer（文字なし・ジャンルの世界観）
 * @param cover  実際の表紙画像 buffer（縦長）
 * @param content バッジ/見出し/タイトル/CTA
 * @param opts   アクセント色
 */
export async function composePromoCreative(
  bg: Buffer,
  cover: Buffer,
  content: PromoContent,
  opts: PromoOptions = {},
): Promise<Buffer> {
  const { regular, bold } = loadFonts();
  const S = 1080;
  const accent = opts.accent ?? '#e0a83a';

  // --- 背景を 1080² にカバー ---
  const base = sharp(bg).resize(S, S, { fit: 'cover', position: 'centre' });

  // --- 表紙を高さ基準でリサイズ（左カラム） ---
  const coverMeta = await sharp(cover).metadata();
  const cw = coverMeta.width ?? 1600;
  const ch = coverMeta.height ?? 2560;
  let dispH = 640;
  let dispW = Math.round(dispH * (cw / ch));
  const maxCoverW = 400;
  if (dispW > maxCoverW) { dispW = maxCoverW; dispH = Math.round(dispW * (ch / cw)); }
  const coverLeft = 84;
  const coverTop = Math.round((S - dispH) / 2) - 20;
  const coverBuf = await sharp(cover).resize(dispW, dispH, { fit: 'fill' }).png().toBuffer();

  // --- 右カラム領域 ---
  const colX = coverLeft + dispW + 56;
  const colW = S - colX - 72;

  // ============ レイヤ1: スクリム＋表紙の影 ============
  const shadowSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
    <defs>
      <linearGradient id="bgtint" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#0c1016" stop-opacity="0.30"/>
        <stop offset="1" stop-color="#0c1016" stop-opacity="0.62"/>
      </linearGradient>
      <linearGradient id="rightpanel" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#0a0d12" stop-opacity="0"/>
        <stop offset="0.35" stop-color="#0a0d12" stop-opacity="0.55"/>
        <stop offset="1" stop-color="#0a0d12" stop-opacity="0.80"/>
      </linearGradient>
      <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="18"/>
      </filter>
    </defs>
    <rect x="0" y="0" width="${S}" height="${S}" fill="url(#bgtint)"/>
    <rect x="${colX - 120}" y="0" width="${S - (colX - 120)}" height="${S}" fill="url(#rightpanel)"/>
    <rect x="${coverLeft + 14}" y="${coverTop + 22}" width="${dispW}" height="${dispH}" rx="10" fill="#05070a" opacity="0.55" filter="url(#sh)"/>
  </svg>`;

  // ============ レイヤ3: バッジ・見出し・タイトル・CTA ============
  // バッジ（ピル）
  const badgeText = content.badge.trim();
  const kuText = content.ku.trim();
  const badgeSize = 30;
  const badgePadX = 22;
  const badgeH = 60;
  const badgeGap = 14;
  const badgeTextW = bold.getAdvanceWidth(badgeText, badgeSize);
  const kuTextW = regular.getAdvanceWidth(kuText, badgeSize);
  const badgeY = 132;
  const badge1W = badgeTextW + badgePadX * 2;
  const badge2W = kuTextW + badgePadX * 2;

  // eyebrow（想定読者・任意）
  const eyebrow = content.eyebrow?.trim();
  const eyebrowSize = 30;
  const eyebrowLines = eyebrow ? wrapByWidth(regular, eyebrow, eyebrowSize, colW) : [];

  // 見出し（ベネフィット）
  const { size: hlSize, lines: hlLines } = fitText(bold, content.headline.trim(), colW, 76, 44, 4);
  const hlLH = hlSize * 1.28;

  // タイトル
  const titleSize = 34;
  const titleLines = wrapByWidth(bold, content.title.trim(), titleSize, colW).slice(0, 2);
  const titleLH = titleSize * 1.3;

  // 縦積みの開始位置（バッジの下）
  let y = badgeY + badgeH + 46;
  const parts: string[] = [];

  // eyebrow
  if (eyebrowLines.length > 0) {
    for (const ln of eyebrowLines) {
      const baseline = y + eyebrowSize * 0.82;
      parts.push(`<path d="${linePathLeft(regular, ln, eyebrowSize, colX, baseline)}" fill="${accent}"/>`);
      y += eyebrowSize * 1.32;
    }
    y += 12;
  }

  // headline（白＋暗いハロー）
  for (const ln of hlLines) {
    const baseline = y + hlSize * 0.82;
    const d = linePathLeft(bold, ln, hlSize, colX, baseline);
    parts.push(`<path d="${d}" fill="none" stroke="#0a0a0a" stroke-width="${(hlSize * 0.09).toFixed(1)}" stroke-linejoin="round" opacity="0.55"/>`);
    parts.push(`<path d="${d}" fill="#ffffff"/>`);
    y += hlLH;
  }

  // アクセント下線
  y += 8;
  parts.push(`<rect x="${colX}" y="${y}" width="76" height="6" rx="3" fill="${accent}"/>`);
  y += 34;

  // title
  for (const ln of titleLines) {
    const baseline = y + titleSize * 0.82;
    const d = linePathLeft(bold, ln, titleSize, colX, baseline);
    parts.push(`<path d="${d}" fill="none" stroke="#0a0a0a" stroke-width="${(titleSize * 0.08).toFixed(1)}" stroke-linejoin="round" opacity="0.5"/>`);
    parts.push(`<path d="${d}" fill="#f2ede2"/>`);
    y += titleLH;
  }

  // CTA バー（下部・全幅寄り）。▶ はフォントに無いので三角ポリゴンを描く。
  const ctaText = content.cta.trim();
  const ctaH = 74;
  const ctaY = S - 56 - ctaH;
  const ctaX = colX;
  const ctaW = S - ctaX - 72;
  const triW = 20;
  const triGap = 16;
  let ctaSize = 32;
  while (ctaSize > 20 && triW + triGap + bold.getAdvanceWidth(ctaText, ctaSize) > ctaW - 44) {
    ctaSize -= 2;
  }
  const ctaTextW = bold.getAdvanceWidth(ctaText, ctaSize);
  const ctaGroupW = triW + triGap + ctaTextW;
  const ctaGroupX = ctaX + (ctaW - ctaGroupW) / 2;
  const ctaMidY = ctaY + ctaH / 2;
  const ctaBaseline = ctaMidY + ctaSize * 0.34;
  const triTop = ctaMidY - 11;
  const triBot = ctaMidY + 11;

  const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
    <!-- badge pills -->
    <rect x="${colX}" y="${badgeY}" width="${badge1W.toFixed(0)}" height="${badgeH}" rx="${badgeH / 2}" fill="${accent}"/>
    <path d="${linePathLeft(bold, badgeText, badgeSize, colX + badgePadX, badgeY + badgeH / 2 + badgeSize * 0.34)}" fill="#1a1206"/>
    <rect x="${(colX + badge1W + badgeGap).toFixed(0)}" y="${badgeY}" width="${badge2W.toFixed(0)}" height="${badgeH}" rx="${badgeH / 2}" fill="none" stroke="${accent}" stroke-width="2.5"/>
    <path d="${linePathLeft(regular, kuText, badgeSize, colX + badge1W + badgeGap + badgePadX, badgeY + badgeH / 2 + badgeSize * 0.34)}" fill="#ffffff"/>
    <!-- headline / title -->
    ${parts.join('\n    ')}
    <!-- CTA -->
    <rect x="${ctaX}" y="${ctaY}" width="${ctaW}" height="${ctaH}" rx="14" fill="${accent}"/>
    <polygon points="${ctaGroupX},${triTop.toFixed(1)} ${ctaGroupX + triW},${ctaMidY.toFixed(1)} ${ctaGroupX},${triBot.toFixed(1)}" fill="#1a1206"/>
    <path d="${linePathLeft(bold, ctaText, ctaSize, ctaGroupX + triW + triGap, ctaBaseline)}" fill="#1a1206"/>
  </svg>`;

  const out = await base
    .composite([
      { input: Buffer.from(shadowSvg), top: 0, left: 0 },
      { input: coverBuf, top: coverTop, left: coverLeft },
      { input: Buffer.from(textSvg), top: 0, left: 0 },
    ])
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();

  return out;
}
