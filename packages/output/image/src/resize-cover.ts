import sharp from 'sharp';

// KDP 電子書籍カバーは縦長 (高さ:幅 = 1.6:1)。推奨 1600 x 2560 px (幅 x 高さ)。
// 旧実装は 2560(幅) x 1600(高さ) の「横長」で、縦長の原画を fit:'cover' で
// 中央クロップしていたため、タイトル/サブタイトルが大きく切れて崩れて見えた。
const KDP_EBOOK_WIDTH = 1600;
const KDP_EBOOK_HEIGHT = 2560;

/**
 * Resize an image buffer to KDP cover dimensions with sRGB ICC profile.
 * Uses sharp's default lanczos3 kernel (bicubic) for high-quality scaling.
 *
 * 出力は JPEG (KDP 表紙は JPEG/TIFF を要求。JPEG はファイルも軽量)。
 * タイポグラフィの劣化を避けるため quality=92 / chromaSubsampling 4:4:4 /
 * mozjpeg を使う。
 */
export async function resizeCover(
  buffer: Buffer,
  width: number = KDP_EBOOK_WIDTH,
  height: number = KDP_EBOOK_HEIGHT,
): Promise<Buffer> {
  const result = await sharp(buffer)
    .resize(width, height, {
      fit: 'cover',
      position: 'centre',
    })
    .toColorspace('srgb')
    .withIccProfile('srgb')
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toBuffer();

  return result;
}
