/**
 * F-041b — detectImage(PNG/JPEG/WebP 寸法判定) の単体テスト。
 */
import { describe, expect, it } from 'vitest';

import { detectImage } from '@/lib/image-dimensions';

function pngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function jpegBuffer(width: number, height: number): Buffer {
  // SOI + SOF0 セグメント(寸法入り)。
  const buf = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x11, // length
    0x08, // precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
  ]);
  return buf;
}

describe('detectImage', () => {
  it('PNG の寸法を読む', () => {
    const info = detectImage(pngBuffer(1024, 1536));
    expect(info).toMatchObject({ format: 'png', ext: 'png', contentType: 'image/png', width: 1024, height: 1536 });
  });

  it('JPEG の寸法を読む', () => {
    const info = detectImage(jpegBuffer(1600, 2560));
    expect(info).toMatchObject({ format: 'jpeg', ext: 'jpg', width: 1600, height: 2560 });
  });

  it('WebP(VP8X) の寸法を読む', () => {
    // RIFF....WEBP VP8X ... canvas 1000x1500
    const buf = Buffer.alloc(30);
    buf.write('RIFF', 0, 'ascii');
    buf.write('WEBP', 8, 'ascii');
    buf.write('VP8X', 12, 'ascii');
    const w = 1000 - 1, h = 1500 - 1;
    buf[24] = w & 0xff; buf[25] = (w >> 8) & 0xff; buf[26] = (w >> 16) & 0xff;
    buf[27] = h & 0xff; buf[28] = (h >> 8) & 0xff; buf[29] = (h >> 16) & 0xff;
    const info = detectImage(buf);
    expect(info).toMatchObject({ format: 'webp', width: 1000, height: 1500 });
  });

  it('非画像は null', () => {
    expect(detectImage(Buffer.from('not an image at all here'))).toBeNull();
    expect(detectImage(Buffer.alloc(4))).toBeNull();
  });
});
