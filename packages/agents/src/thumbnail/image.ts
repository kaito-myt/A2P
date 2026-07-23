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
  editImage as defaultEditImage,
  IMAGE_MODEL,
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
  /** Override the gpt-image-1 edit call used for the typography refine pass. */
  editImage?: GenerateImageFn;
  /**
   * タイポグラフィ再描画パス (ChatGPT/gpt-image-1 edit) を実行するか。既定 true。
   * false にすると実フォント合成版をそのまま最終カバーにする。
   */
  refineTypography?: boolean;
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
  // gpt-image-1 は日本語タイポグラフィを正確かつ美しくデザイン統合して描けるため、
  // ChatGPT で手作業した時と同じく「文字ごとデザインさせる」1 パス方式を採る
  // (旧: 文字なし生成→フラット実フォント合成→refine の3段は品質が劣るため廃止)。
  // アート方向性 (styleGuide) が絵作り・配色・世界観を主導する。
  const artDirection =
    input.styleGuide && input.styleGuide.trim().length > 0
      ? input.styleGuide.trim()
      : `A clean, modern, commercially appealing Japanese Kindle book-cover that visually evokes the theme of "${input.title}". Choose a tasteful, professional style appropriate to the topic (photographic, minimalist, symbolic, or illustrated), with a refined, intentional color palette.`;

  // 運営者の実証済みフォーマット（ブラウザ ChatGPT で高品質だった構造）を踏襲:
  //   「下記の内容の本を KDP 出版するので表紙を作成してください / ・タイトル / ・サブタイトル / ・特記事項」
  // 特記事項＝アートディレクション（イラストの調子・世界観・配色・構図）。
  const lines: string[] = [
    '下記の内容の本を Amazon KDP（Kindle）で出版します。書店で売れる、プロがデザインした目を引く表紙を1枚作成してください。',
    '',
    `・タイトル：「${input.title}」`,
  ];
  if (input.subtitle && input.subtitle.trim().length > 0) {
    lines.push(`・サブタイトル：「${input.subtitle}」`);
  }
  if (input.author && input.author.trim().length > 0) {
    lines.push(`・著者名：「${input.author}」`);
  }
  lines.push(
    `・特記事項：${artDirection}`,
    '',
    '要件:',
    '- 縦長(portrait)・高解像度・印刷可能品質。サムネイル（小さな一覧表示）でも一瞬で目を引き、内容が伝わり、競合に埋もれない。',
    '- 上記の日本語（タイトル／サブタイトル／著者名）は **一字一句正確に**（翻訳・変換・省略・追加をせず、崩さず、読みやすく）表紙に配置する。タイトルを最も大きく主役にし、明確な階層と上質なタイポグラフィでデザインに統合する。',
    '- 上記以外の文字・ロゴ・透かし・バーコード・価格・キャプションは一切描かない。',
    '- 安っぽい AI 感を避け、洗練された意図的な構図と奥行き。人物が出る場合は自然な解剖学（手指・顔・目、余分な四肢なし）。枠/縁取り/UI要素/ストック写真コラージュ/濁った過飽和グラデーションは使わない。健全な内容。',
  );
  return lines.join('\n');
}

/**
 * タイポグラフィ再描画パス用のプロンプト。
 *
 * 入力: 実フォントで文字を焼き込んだ「下絵」カバー。
 * 目的: 文字の内容・配置はそのままに、タイポグラフィだけを「売れる本」らしい
 *       魅力的なデザインに描き直す。日本語を **一字一句正確** に描かせるのが最重要。
 */
function buildRefinePrompt(text: CoverText): string {
  const lines: string[] = [
    'This is a draft Japanese book cover. The artwork and the text placement are already correct.',
    'Redraw this SAME cover, keeping the artwork and overall composition essentially unchanged, but elevate the TITLE TYPOGRAPHY into a polished, eye-catching, best-selling Amazon Kindle book-cover design (strong hierarchy, tasteful weight/contrast, a premium and appealing look — not a plain, thin, unstyled font).',
    '',
    'ABSOLUTELY CRITICAL — render the Japanese text EXACTLY as written below. Do NOT translate, transliterate, paraphrase, abbreviate, add, drop, reorder or corrupt any character. Every kanji, hiragana and katakana must be perfectly correct and legible:',
    `- タイトル (title): 「${text.title}」`,
  ];
  if (text.subtitle && text.subtitle.trim().length > 0) {
    lines.push(`- サブタイトル (subtitle): 「${text.subtitle}」`);
  }
  if (text.author && text.author.trim().length > 0) {
    lines.push(`- 著者名 (author): 「${text.author}」`);
  }
  lines.push(
    '',
    'Rules:',
    '- The title must be the dominant, most prominent element. Subtitle smaller; author name smallest, near the bottom.',
    '- Keep the text fully inside the cover with safe margins; high contrast against the background so it is easy to read at thumbnail size.',
    '- Do NOT add any extra words, logos, watermarks, barcodes, price tags, or captions that are not listed above.',
    '- Preserve the vertical (portrait) book-cover orientation.',
    '',
    'Output: the same cover with beautiful, accurate Japanese typography.',
  );
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

  const coverText: CoverText = { title: parsed.title };
  if (parsed.subtitle && parsed.subtitle.trim().length > 0) {
    coverText.subtitle = parsed.subtitle;
  }
  if (parsed.author && parsed.author.trim().length > 0) {
    coverText.author = parsed.author;
  }

  // --- 4. 文字はプロンプトでデザイン統合済み。原則そのまま最終カバーとして使う。 ---
  //   万一の文字化けは cover_text_check(ビジョン検査)＋recheck ループが検知して作り直す。
  //   deps.composeTypography が明示注入された場合のみ、旧方式(実フォント合成)を適用できる
  //   (テスト/フォールバック用途)。既定は 1 パス統合生成の結果を使う。
  let finalImage = illustration;
  let refineApplied = false;
  if (deps.composeTypography) {
    finalImage = await deps.composeTypography(illustration, coverText);
    refineApplied = true;
  }

  // --- 5. Generate cover ID and R2 key ---
  const coverId = (deps.generateId ?? defaultGenerateId)();
  const r2Key = bookArtifact(parsed.bookId, 'cover_source', `${coverId}.jpg`);

  // --- 6. Upload final cover to R2 ---
  const upload = deps.uploadBuffer ?? defaultUploadBuffer;
  await upload(r2Key, finalImage, 'image/jpeg');

  // --- 7. INSERT Cover row ---
  const coverRepo = deps.prisma?.cover ?? (await defaultCoverRepo());

  const generationMeta = {
    provider: 'openai',
    model: IMAGE_MODEL,
    cost_jpy: costJpy,
    width: parsed.width,
    height: parsed.height,
    image_size_bytes: finalImage.byteLength,
    format: 'jpeg',
    // 文字は実フォントで合成後、gpt-image-1 edit で魅力的なタイポグラフィへ再描画。
    text_overlay: true,
    // true: gpt-image-1 edit で再描画済 / false: 実フォント合成版をそのまま採用。
    typography_refined: refineApplied,
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
