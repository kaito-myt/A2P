/**
 * カバー表紙のタイポグラフィ合成 (文字化け根絶の中核)。
 *
 * gpt-image-1 等の画像生成 AI は日本語 (漢字/かな) を正しく描けない。そこで
 * 本モジュールは「AI が生成した文字なしイラスト」の上に、タイトル/サブタイトル/
 * 著者名を **本物の日本語フォント (Noto Sans JP) でベクター合成**する。
 *
 * 実装方針:
 *   - opentype.js でフォントを読み、各行を SVG <path> (グリフのアウトライン) に変換。
 *     → 描画時にフォント解決 (fontconfig) が不要になり、librsvg でもタフ (□) 化しない。
 *   - sharp の composite で SVG レイヤをイラストに重ねる。
 *   - 下部にスクリム (暗いグラデーション) を敷き、白文字＋暗いハロー (縁取り) で
 *     どんな絵柄の上でも可読性を担保する。
 *
 * 文字は 100% 正確・毎回同一品質。プロの書籍表紙 (絵と文字は別レイヤー) と同じ作り。
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
  // opentype.loadSync は非推奨 (undefined を返す)。parse(readFileSync) が現行 API。
  const buf = readFileSync(path);
  // Node Buffer -> ArrayBuffer (opentype は ArrayBuffer を期待)。
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return opentype.parse(ab);
}

function loadFonts(): { regular: opentype.Font; bold: opentype.Font } {
  if (!regularFont) regularFont = loadFont(REGULAR_FONT_PATH);
  if (!boldFont) boldFont = loadFont(BOLD_FONT_PATH);
  return { regular: regularFont, bold: boldFont };
}

export interface CoverText {
  /** タイトル (必須)。改行 (\n) で明示的な行分けも可。 */
  title: string;
  /** サブタイトル (任意)。 */
  subtitle?: string;
  /** 著者名 (任意)。 */
  author?: string;
}

export interface ComposeCoverOptions {
  /** タイトル文字色 (既定 白)。 */
  titleColor?: string;
  /** アクセント (サブタイトル) 色 (既定 やや暖色の白)。 */
  subtitleColor?: string;
  /** 文字ブロックの縦位置。'bottom' (既定) / 'top'。 */
  placement?: 'bottom' | 'top';
}

// ---------------------------------------------------------------------------
// テキスト折返し (日本語は空白が無いので文字単位で幅計測して折る)
// ---------------------------------------------------------------------------

function wrapByWidth(
  font: opentype.Font,
  text: string,
  fontSize: number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of Array.from(text)) {
    if (ch === '\n') {
      lines.push(cur);
      cur = '';
      continue;
    }
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

/** タイトルが maxLines 以内に収まる最大フォントサイズを二分せず線形に探す。 */
function fitTitle(
  font: opentype.Font,
  title: string,
  maxWidth: number,
  startSize: number,
  minSize: number,
  maxLines: number,
): { size: number; lines: string[] } {
  let size = startSize;
  let lines = wrapByWidth(font, title, size, maxWidth);
  while (lines.length > maxLines && size > minSize) {
    size -= Math.max(2, Math.round(size * 0.06));
    lines = wrapByWidth(font, title, size, maxWidth);
  }
  return { size, lines };
}

// ---------------------------------------------------------------------------
// SVG グリフパス生成
// ---------------------------------------------------------------------------

interface RenderedLine {
  /** SVG path data (グリフアウトライン)。 */
  d: string;
}

/** 1 行を中央寄せで指定 baseline y に配置し、SVG path data を返す。 */
function lineToPath(
  font: opentype.Font,
  text: string,
  fontSize: number,
  centerX: number,
  baselineY: number,
): RenderedLine {
  const advance = font.getAdvanceWidth(text, fontSize);
  const x = centerX - advance / 2;
  const path = font.getPath(text, x, baselineY, fontSize);
  return { d: path.toPathData(2) };
}

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

/**
 * イラスト buffer にタイトル/サブタイトル/著者名を焼き込み、JPEG buffer を返す。
 *
 * @param image  文字なしイラストの画像 buffer (任意フォーマット)
 * @param text   焼き込む文言
 * @param opts   レイアウト/配色オプション
 */
export async function composeCoverTypography(
  image: Buffer,
  text: CoverText,
  opts: ComposeCoverOptions = {},
): Promise<Buffer> {
  const { regular, bold } = loadFonts();

  const base = sharp(image);
  const meta = await base.metadata();
  const width = meta.width ?? 1024;
  const height = meta.height ?? 1536;

  const titleColor = opts.titleColor ?? '#ffffff';
  const subtitleColor = opts.subtitleColor ?? '#f4ede0';
  const authorColor = '#ece5d8';
  const placement = opts.placement ?? 'bottom';

  const sidePad = width * 0.08;
  const maxTextWidth = width - sidePad * 2;

  // --- フォントサイズ (画像幅基準) ---
  const titleStart = width * 0.128;
  const titleMin = width * 0.058;
  const { size: titleSize, lines: titleLines } = fitTitle(
    bold,
    text.title,
    maxTextWidth,
    titleStart,
    titleMin,
    3,
  );
  const titleLH = titleSize * 1.32;

  const subtitleSize = width * 0.05;
  const subtitleLH = subtitleSize * 1.3;
  const subtitleLines = text.subtitle
    ? wrapByWidth(regular, text.subtitle, subtitleSize, maxTextWidth)
    : [];

  const authorSize = width * 0.042;
  const authorLH = authorSize * 1.3;
  const hasAuthor = Boolean(text.author && text.author.trim().length > 0);

  const gapTitleSub = subtitleLines.length > 0 ? titleSize * 0.42 : 0;
  const gapSubAuthor = hasAuthor ? titleSize * 0.5 : 0;

  const blockHeight =
    titleLines.length * titleLH +
    gapTitleSub +
    subtitleLines.length * subtitleLH +
    gapSubAuthor +
    (hasAuthor ? authorLH : 0);

  const outerPad = height * 0.07;
  const blockTop =
    placement === 'bottom' ? height - outerPad - blockHeight : outerPad;

  // --- スクリム (可読性のためのグラデーション) ---
  const scrimStart = Math.max(0, blockTop - height * 0.1);
  const scrimHeight = height - scrimStart;
  const scrimStops =
    placement === 'bottom'
      ? `<stop offset="0" stop-color="#0a0a0a" stop-opacity="0"/>
         <stop offset="0.45" stop-color="#0a0a0a" stop-opacity="0.5"/>
         <stop offset="1" stop-color="#0a0a0a" stop-opacity="0.82"/>`
      : `<stop offset="0" stop-color="#0a0a0a" stop-opacity="0.82"/>
         <stop offset="1" stop-color="#0a0a0a" stop-opacity="0"/>`;

  // --- 各行を path 化 ---
  const centerX = width / 2;
  const haloParts: string[] = [];
  const fillParts: string[] = [];

  let cursorBaseline = blockTop;

  const pushLine = (
    font: opentype.Font,
    line: string,
    size: number,
    lh: number,
    color: string,
    haloWidth: number,
  ): void => {
    // baseline はおおよそ行上端 + size*0.82 の位置
    const baseline = cursorBaseline + size * 0.82;
    const { d } = lineToPath(font, line, size, centerX, baseline);
    haloParts.push(
      `<path d="${d}" fill="none" stroke="#0a0a0a" stroke-width="${haloWidth.toFixed(
        1,
      )}" stroke-linejoin="round" stroke-linecap="round" opacity="0.6"/>`,
    );
    fillParts.push(`<path d="${d}" fill="${escapeXmlAttr(color)}"/>`);
    cursorBaseline += lh;
  };

  for (const line of titleLines) {
    pushLine(bold, line, titleSize, titleLH, titleColor, titleSize * 0.08);
  }
  if (subtitleLines.length > 0) {
    cursorBaseline += gapTitleSub;
    for (const line of subtitleLines) {
      pushLine(regular, line, subtitleSize, subtitleLH, subtitleColor, subtitleSize * 0.07);
    }
  }
  if (hasAuthor) {
    cursorBaseline += gapSubAuthor;
    pushLine(regular, text.author!.trim(), authorSize, authorLH, authorColor, authorSize * 0.07);
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      ${scrimStops}
    </linearGradient>
  </defs>
  <rect x="0" y="${scrimStart.toFixed(1)}" width="${width}" height="${scrimHeight.toFixed(
    1,
  )}" fill="url(#scrim)"/>
  ${haloParts.join('\n  ')}
  ${fillParts.join('\n  ')}
</svg>`;

  const composed = await base
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();

  return composed;
}
