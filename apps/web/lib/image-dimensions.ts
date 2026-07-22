/**
 * 手動アップロードされたカバー画像の寸法/形式を、外部ライブラリ(sharp)無しで判定する。
 * PNG / JPEG / WebP をサポート。KDP カバーの実寸変換は worker(sharp)側の export が行うため、
 * ここでは Cover 行に記録する width/height と content-type の判定だけを目的とする。
 */

export interface ImageInfo {
  format: 'png' | 'jpeg' | 'webp';
  contentType: string;
  ext: 'png' | 'jpg' | 'webp';
  width: number;
  height: number;
}

/** 画像バイト列から形式と寸法を判定する。判定不能なら null。 */
export function detectImage(buf: Buffer): ImageInfo | null {
  const png = detectPng(buf);
  if (png) return png;
  const jpeg = detectJpeg(buf);
  if (jpeg) return jpeg;
  const webp = detectWebp(buf);
  if (webp) return webp;
  return null;
}

function detectPng(buf: Buffer): ImageInfo | null {
  // PNG signature + IHDR (width/height は byte 16-24)。
  if (buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0) return null;
  return { format: 'png', contentType: 'image/png', ext: 'png', width, height };
}

function detectJpeg(buf: Buffer): ImageInfo | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1]!;
    // SOF0..SOF15 (0xC0-0xCF) を除く一部は寸法を持つ SOF。C4/C8/CC は非 SOF。
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      if (width <= 0 || height <= 0) return null;
      return { format: 'jpeg', contentType: 'image/jpeg', ext: 'jpg', width, height };
    }
    // セグメント長で次へスキップ。
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2) return null;
    offset += 2 + segLen;
  }
  return null;
}

function detectWebp(buf: Buffer): ImageInfo | null {
  // RIFF....WEBP
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fourcc = buf.toString('ascii', 12, 16);
  try {
    if (fourcc === 'VP8 ') {
      // lossy: 寸法は frame tag の後 (offset 26)。
      const width = buf.readUInt16LE(26) & 0x3fff;
      const height = buf.readUInt16LE(28) & 0x3fff;
      if (width > 0 && height > 0) return { format: 'webp', contentType: 'image/webp', ext: 'webp', width, height };
    } else if (fourcc === 'VP8L') {
      // lossless: offset 21 から 14bit ずつ。
      const b0 = buf[21]!, b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!;
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      if (width > 0 && height > 0) return { format: 'webp', contentType: 'image/webp', ext: 'webp', width, height };
    } else if (fourcc === 'VP8X') {
      // extended: canvas 寸法は offset 24 から 24bit(-1)。
      const width = 1 + ((buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)) & 0xffffff);
      const height = 1 + ((buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) & 0xffffff);
      if (width > 0 && height > 0) return { format: 'webp', contentType: 'image/webp', ext: 'webp', width, height };
    }
  } catch {
    return null;
  }
  return null;
}
