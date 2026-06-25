import sharp from 'sharp';

const KDP_EBOOK_WIDTH = 2560;
const KDP_EBOOK_HEIGHT = 1600;

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
