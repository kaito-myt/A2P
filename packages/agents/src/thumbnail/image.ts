/**
 * docs/05 ss6.3.4 / F-007 -- Thumbnail Designer (cover image generation).
 *
 * 【文字化け根絶の設計】
 * gpt-image-1 は日本語 (漢字/かな) を正しく描けない。そこで本実装は:
 *   1. gpt-image-1 に **文字を一切含まないイラストだけ**を生成させる
 *      (アート方向性 styleGuide = cover_art_direction エージェントの出力で駆動)。
 *   2. その上にタイトル/サブタイトル/著者名を **本物の日本語フォントでベクター合成**
 *      する (`composeCoverTypography` in @a2p/output-image)。
 * これで日本語は 100% 正確・毎回同一品質になる (プロの書籍表紙と同じ「絵と文字は別レイヤー」)。
 *
 * Flow:
 *  1. アート方向性から「文字なし」画像生成プロンプトを構築
 *  2. `generateImage` (via `withImageLogging`) で gpt-image-1 から文字なしイラストを取得
 *  3. `composeCoverTypography` でタイトル等を焼き込み、最終 JPEG を得る
 *  4. 最終画像を R2 に upload (`books/{book_id}/covers/raw/{cover_id}.jpg`)
 *  5. `Cover` 行を INSERT (status='generated')
 *  6. Return { r2Key, promptUsed, coverId }
 *
 * DI: すべての外部依存 (generateImage, composeTypography, uploadBuffer, prisma, cuid)
 * は `deps` で差し替え可能 (実 API / DB / R2 に触れずテスト可能)。
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
  composeCoverTypography as defaultComposeCoverTypography,
  type CoverText,
} from '@a2p/output-image';

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

/** タイポグラフィ合成関数の最小シグネチャ (テスト差し替え用)。 */
export type ComposeTypographyFn = (image: Buffer, text: CoverText) => Promise<Buffer>;

export interface GenerateCoverImageDeps {
  /** Override `generateImage` (default: real OpenAI call). */
  generateImage?: GenerateImageFn;
  /** Override `generateImage` inner deps (apiKey factory, openai factory). */
  imageGenDeps?: ImageGenDeps;
  /** Override `withImageLogging` deps (prisma for token_usage, price snapshot). */
  withImageLoggingDeps?: WithImageLoggingDeps;
  /** Override typography compositor (default: real `composeCoverTypography`). */
  composeTypography?: ComposeTypographyFn;
  /** Override R2 upload function (default: `uploadBuffer` from @a2p/storage). */
  uploadBuffer?: UploadBufferFn;
  /** Override Prisma cover repo (default: real prisma.cover). */
  prisma?: { cover: CoverRepo };
  /** Override ID generator (default: crypto.randomUUID). */
  generateId?: () => string;
}

// ---------------------------------------------------------------------------
// Prompt builder — 「文字なし」イラストを生成する
// ---------------------------------------------------------------------------

function buildImagePrompt(input: ThumbnailImageInput): string {
  // タイトル等は後で別レイヤー合成するので、AI には文字を描かせない。
  // アート方向性 (styleGuide) が絵作りを主導する。空ならジャンル汎用のフォールバック。
  const artDirection =
    input.styleGuide && input.styleGuide.trim().length > 0
      ? input.styleGuide.trim()
      : `A clean, modern, commercially appealing book-cover artwork that visually evokes the theme of "${input.title}". Choose a tasteful, professional style appropriate to the topic (photographic, minimalist, symbolic, or illustrated).`;

  const lines: string[] = [
    'Create a professional, commercially appealing book-cover ARTWORK (illustration or photographic composition), portrait orientation, high quality, print-ready.',
    '',
    'Art direction (follow this closely — it defines the visual concept, style, subject, composition, mood and palette):',
    artDirection,
    '',
    'ABSOLUTELY CRITICAL — NO TEXT:',
    '- Do NOT render ANY text, letters, words, kanji, kana, numbers, titles, captions, labels, logos, watermarks or signatures ANYWHERE in the image.',
    '- The title, subtitle and author name are added later as a separate typography layer. The artwork itself must be 100% text-free.',
    '- Keep the LOWER third of the image relatively clean and simple (calmer, lower-detail, or a smooth area) so title text can be overlaid legibly on top.',
    '',
    'Quality guardrails (avoid the cheap AI look):',
    '- Polished, intentional, professional composition with depth.',
    '- If human characters appear: correct anatomy (natural hands, fingers, faces, eyes; no extra or fused limbs).',
    '- No borders or frames, no UI elements, no stock-photo collage, no muddy/oversaturated rainbow gradients.',
    '- Keep it SFW and appropriate for a general Amazon storefront.',
    '',
    'Output: a sharp, high-quality vertical book-cover artwork with NO text anywhere.',
  ];
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
 * gpt-image-1 で「文字なしイラスト」を生成し、タイトル/サブタイトル/著者名を
 * 実フォントで合成して最終カバーを作り、R2 に upload、`Cover` 行を INSERT する。
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

  // --- 1. Build prompt (文字なし) ---
  const prompt = buildImagePrompt(parsed);

  // --- 2. Prepare image generation function with token logging ---
  const baseFn: GenerateImageFn = deps.generateImage ?? defaultGenerateImage;
  const loggingCtx: ImageLoggingContext = {
    bookId: parsed.bookId,
    jobId: parsed.jobId,
  };
  const wrappedFn = withImageLogging(baseFn, loggingCtx, deps.withImageLoggingDeps);

  // --- 3. Generate a text-free illustration ---
  const genResult = await wrappedFn(
    {
      prompt,
      width: parsed.width,
      height: parsed.height,
      count: 1,
      // 高品質設定で「AI っぽさ」を抑える。
      quality: 'high',
      // JPEG 生成 (KDP 表紙は JPEG/TIFF、ファイルも軽量)。
      outputFormat: 'jpeg',
      outputCompression: 92,
    },
    deps.imageGenDeps,
  );
  const illustration = genResult.images[0]!;
  const costJpy = genResult.costJpy;

  // --- 4. Composite real Japanese typography over the illustration ---
  const compose = deps.composeTypography ?? defaultComposeCoverTypography;
  const coverText: CoverText = { title: parsed.title };
  if (parsed.subtitle && parsed.subtitle.trim().length > 0) {
    coverText.subtitle = parsed.subtitle;
  }
  if (parsed.author && parsed.author.trim().length > 0) {
    coverText.author = parsed.author;
  }
  const finalImage = await compose(illustration, coverText);

  // --- 5. Generate cover ID and R2 key ---
  const coverId = (deps.generateId ?? defaultGenerateId)();
  const r2Key = bookArtifact(parsed.bookId, 'cover_source', `${coverId}.jpg`);

  // --- 6. Upload composited cover to R2 ---
  const upload = deps.uploadBuffer ?? defaultUploadBuffer;
  await upload(r2Key, finalImage, 'image/jpeg');

  // --- 7. INSERT Cover row ---
  const coverRepo = deps.prisma?.cover ?? (await defaultCoverRepo());

  const generationMeta = {
    provider: 'openai',
    model: 'gpt-image-1',
    cost_jpy: costJpy,
    width: parsed.width,
    height: parsed.height,
    image_size_bytes: finalImage.byteLength,
    format: 'jpeg',
    // 文字は AI ではなく実フォントで合成済 (文字化けは原理的に発生しない)。
    text_overlay: true,
    style_guide: parsed.styleGuide ?? '',
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

  // --- 8. Validate and return ---
  const output: ThumbnailImageOutput = {
    r2Key,
    promptUsed: prompt,
    coverId,
  };

  return ThumbnailImageOutputSchema.parse(output);
}
