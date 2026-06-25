import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { resizeCover } from '../src/resize-cover.js';

function createTestImage(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 128, g: 64, b: 32 },
    },
  })
    .png()
    .toBuffer();
}

describe('resizeCover', () => {
  it('upscales a small image to default KDP dimensions (2560x1600)', async () => {
    const input = await createTestImage(256, 160);
    const output = await resizeCover(input);
    const meta = await sharp(output).metadata();

    expect(meta.width).toBe(2560);
    expect(meta.height).toBe(1600);
    expect(meta.format).toBe('jpeg');
  });

  it('downscales a large image to default KDP dimensions (2560x1600)', async () => {
    const input = await createTestImage(5120, 3200);
    const output = await resizeCover(input);
    const meta = await sharp(output).metadata();

    expect(meta.width).toBe(2560);
    expect(meta.height).toBe(1600);
    expect(meta.format).toBe('jpeg');
  });

  it('resizes to custom dimensions when specified', async () => {
    const input = await createTestImage(800, 600);
    const output = await resizeCover(input, 1920, 1080);
    const meta = await sharp(output).metadata();

    expect(meta.width).toBe(1920);
    expect(meta.height).toBe(1080);
  });

  it('outputs sRGB colorspace with embedded ICC profile', async () => {
    const input = await createTestImage(512, 320);
    const output = await resizeCover(input);
    const meta = await sharp(output).metadata();

    expect(meta.space).toBe('srgb');
    expect(meta.icc).toBeDefined();
    expect(meta.icc!.length).toBeGreaterThan(0);
  });

  it('handles non-matching aspect ratio via cover fit', async () => {
    const input = await createTestImage(1000, 1000);
    const output = await resizeCover(input);
    const meta = await sharp(output).metadata();

    expect(meta.width).toBe(2560);
    expect(meta.height).toBe(1600);
  });

  it('produces a valid JPEG buffer', async () => {
    const input = await createTestImage(400, 250);
    const output = await resizeCover(input);

    expect(output).toBeInstanceOf(Buffer);
    expect(output.length).toBeGreaterThan(0);
    // JPEG SOI マーカー (FF D8 FF)
    expect(output[0]).toBe(0xff);
    expect(output[1]).toBe(0xd8);
    expect(output[2]).toBe(0xff);
  });
});
