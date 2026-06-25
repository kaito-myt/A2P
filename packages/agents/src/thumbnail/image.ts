/**
 * docs/05 ss6.3.4 / F-007 -- Thumbnail Designer (cover image generation).
 *
 * Flow:
 *  1. Build an image-gen prompt from the cover text proposal (title/subtitle)
 *     and the style guide
 *  2. Call `generateImage` (via `withImageLogging` for token_usage recording)
 *     to get a raw JPEG buffer from gpt-image-1 (output_format='jpeg')
 *  3. Upload raw image to R2 at `books/{book_id}/covers/raw/{cover_id}.jpg`
 *  4. INSERT a `Cover` row (r2_key, width, height, prompt_used,
 *     generation_meta_json, status='generated')
 *  5. Return { r2Key, promptUsed, coverId }
 *
 * DI: all external dependencies (generateImage, uploadBuffer, prisma, cuid)
 * are injectable via `deps` for testing without real API / DB / R2 calls.
 */
import { randomUUID } from 'node:crypto';

import {
  ThumbnailImageInputSchema,
  ThumbnailImageOutputSchema,
  type ThumbnailImageInput,
  type ThumbnailImageOutput,
} from '@a2p/contracts/agents/thumbnail';

import { bookArtifact } from '@a2p/storage/keys';

import {
  generateImage as defaultGenerateImage,
  type GenerateImageFn,
  type ImageGenDeps,
} from '../tools/image-gen.js';
import {
  withImageLogging,
  type ImageLoggingContext,
  type WithImageLoggingDeps,
} from '../lib/with-image-logging.js';

// ---------------------------------------------------------------------------
// DI interfaces (minimal surface for testability)
// ---------------------------------------------------------------------------

interface CoverCreateData {
  id: string;
  book_id: string;
  cover_text_id: string | null;
  r2_key: string;
  prompt_used: string;
  width: number;
  height: number;
  status: string;
  generation_meta_json: unknown;
}

interface CoverRepo {
  create(args: { data: CoverCreateData }): Promise<{ id: string }>;
}

interface UploadBufferFn {
  (
    key: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<{ key: string; sha256: string; size: number; contentType: string }>;
}

export interface GenerateCoverImageDeps {
  /** Override `generateImage` (default: real OpenAI call). */
  generateImage?: GenerateImageFn;
  /** Override `generateImage` inner deps (apiKey factory, openai factory). */
  imageGenDeps?: ImageGenDeps;
  /** Override `withImageLogging` deps (prisma for token_usage, price snapshot). */
  withImageLoggingDeps?: WithImageLoggingDeps;
  /** Override R2 upload function (default: `uploadBuffer` from @a2p/storage). */
  uploadBuffer?: UploadBufferFn;
  /** Override Prisma cover repo (default: real prisma.cover). */
  prisma?: { cover: CoverRepo };
  /** Override ID generator (default: crypto.randomUUID). */
  generateId?: () => string;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildImagePrompt(input: ThumbnailImageInput): string {
  // gpt-image-1 はアートディレクションを英語で詳細に与えると追従性が高い。
  // 方針: 親しみやすく手に取られやすい「日本のライトノベル風イラスト表紙」。
  // ただし崩れた日本語・余計な文字・崩れた手指などの「安っぽい AI 感」は明確に排除する。
  const lines: string[] = [
    'Create a Japanese light-novel style illustrated book cover (ライトノベル風), portrait orientation,',
    'high-quality professional anime/manga illustration as if published by a major light-novel label.',
    '',
    'Exact text to place on the cover (use these characters verbatim, and NO other text):',
    `- Main title (large, bold, dominant): 「${input.title}」`,
  ];
  if (input.subtitle) {
    lines.push(`- Subtitle (smaller, secondary): 「${input.subtitle}」`);
  }
  lines.push(
    '',
    'Illustration direction:',
    '- Appealing anime/manga illustration: clean confident line art, soft cel shading, vibrant yet tasteful colors, bright lighting.',
    '- Feature an attractive, expressive anime-style character (and/or an evocative scene) that fits the book topic implied by the title.',
    '- Dynamic, eye-catching composition with depth; polished, modern light-novel aesthetic that makes readers want to pick it up.',
    '- Leave clear space at the top or bottom so the title typography sits cleanly over the artwork and stays readable as a small thumbnail.',
    '',
    'Typography (critical):',
    '- Render the Japanese title in crisp, perfectly legible type with CORRECT kanji and kana, well integrated with the illustration.',
    '- Absolutely no garbled, distorted, mojibake, or invented characters.',
    '- Do NOT add any text other than the title and subtitle above (no fake author lines, no logos, no labels, no lorem text).',
    '',
    'Quality guardrails (avoid the cheap AI look):',
    '- Correct anatomy: natural hands, fingers, eyes and faces; no extra or fused limbs.',
    '- No watermarks, no borders or frames, no signature, no UI elements, no stock-photo collage.',
    '- Avoid muddy or oversaturated rainbow gradients and cluttered backgrounds; keep it crisp and intentional.',
  );
  if (input.styleGuide) {
    lines.push('', `Additional style guidance: ${input.styleGuide}`);
  }
  lines.push('', 'Output: a print-ready, sharp, high-quality vertical light-novel cover illustration.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Default helpers
// ---------------------------------------------------------------------------

async function defaultUploadBuffer(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<{ key: string; sha256: string; size: number; contentType: string }> {
  const mod = await import('@a2p/storage/operations');
  return mod.uploadBuffer(key, buffer, contentType);
}

async function defaultCoverRepo(): Promise<CoverRepo> {
  const mod = await import('@a2p/db');
  return (mod.prisma as unknown as { cover: CoverRepo }).cover;
}

function defaultGenerateId(): string {
  return randomUUID().replace(/-/g, '');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * F-007: Generate a single cover image for a book.
 *
 * Calls gpt-image-1 via `generateImage` (wrapped with `withImageLogging`
 * for token_usage recording), uploads the raw JPEG to R2, and creates a
 * `Cover` DB row.
 *
 * @throws ProviderError  gpt-image-1 API failure (after retries)
 * @throws StorageError   R2 upload failure
 * @throws PrismaError    Cover INSERT failure
 */
export async function generateCoverImage(
  input: ThumbnailImageInput,
  deps: GenerateCoverImageDeps = {},
): Promise<ThumbnailImageOutput> {
  const parsed = ThumbnailImageInputSchema.parse(input);

  // --- 1. Build prompt ---
  const prompt = buildImagePrompt(parsed);

  // --- 2. Prepare image generation function with token logging ---
  const baseFn: GenerateImageFn = deps.generateImage ?? defaultGenerateImage;
  const loggingCtx: ImageLoggingContext = {
    bookId: parsed.bookId,
    jobId: parsed.jobId,
  };
  const wrappedFn = withImageLogging(baseFn, loggingCtx, deps.withImageLoggingDeps);

  // --- 3. Generate image ---
  const result = await wrappedFn(
    {
      prompt,
      width: parsed.width,
      height: parsed.height,
      count: 1,
      // 高品質設定で「AI っぽさ」を抑え、タイポグラフィの破綻を減らす。
      quality: 'high',
      // サムネ画像は JPEG で出力する (KDP 表紙は JPEG/TIFF。ファイルも軽量)。
      // 圧縮率はタイポグラフィの劣化を避けるため高め。
      outputFormat: 'jpeg',
      outputCompression: 92,
    },
    deps.imageGenDeps,
  );

  const imageBuffer = result.images[0]!;

  // --- 4. Generate cover ID and R2 key ---
  const coverId = (deps.generateId ?? defaultGenerateId)();

  const r2Key = bookArtifact(parsed.bookId, 'cover_source', `${coverId}.jpg`);

  // --- 5. Upload to R2 ---
  const upload = deps.uploadBuffer ?? defaultUploadBuffer;
  await upload(r2Key, imageBuffer, 'image/jpeg');

  // --- 6. INSERT Cover row ---
  const coverRepo = deps.prisma?.cover ?? await defaultCoverRepo();

  const generationMeta = {
    provider: 'openai',
    model: 'gpt-image-1',
    cost_jpy: result.costJpy,
    width: parsed.width,
    height: parsed.height,
    image_size_bytes: imageBuffer.byteLength,
    format: 'jpeg',
  };

  await coverRepo.create({
    data: {
      id: coverId,
      book_id: parsed.bookId,
      cover_text_id: parsed.coverTextId ?? null,
      r2_key: r2Key,
      prompt_used: prompt,
      width: parsed.width,
      height: parsed.height,
      status: 'generated',
      generation_meta_json: generationMeta,
    },
  });

  // --- 7. Validate and return ---
  const output: ThumbnailImageOutput = {
    r2Key,
    promptUsed: prompt,
    coverId,
  };

  return ThumbnailImageOutputSchema.parse(output);
}
