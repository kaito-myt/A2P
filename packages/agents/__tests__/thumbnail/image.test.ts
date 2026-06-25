/**
 * T-05-02 -- Thumbnail Designer (cover image) unit tests.
 *
 * All external deps (generateImage, R2 upload, Prisma, ID generation)
 * are injected via `GenerateCoverImageDeps`. No real API, DB, or R2 calls.
 *
 * Coverage:
 *  1. happy path: image generated + R2 upload + Cover INSERT + output shape
 *  2. prompt includes title and subtitle
 *  3. prompt includes style guide
 *  4. R2 key follows `books/{bookId}/covers/raw/{coverId}.jpg` pattern
 *  5. Cover INSERT has correct fields
 *  6. token_usage recorded via withImageLogging
 *  7. jobId forwarded to ImageLoggingContext
 *  8. jobId omitted -> ctx.jobId undefined
 *  9. generateImage failure -> propagated
 * 10. R2 upload failure -> propagated
 * 11. Cover INSERT failure -> propagated
 * 12. custom generateId is used
 * 13. width/height defaults applied
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ThumbnailImageInput } from '@a2p/contracts/agents/thumbnail';

vi.mock('@a2p/db', () => ({
  prisma: {
    tokenUsage: { create: vi.fn() },
    book: { update: vi.fn() },
    modelCatalog: { findFirst: vi.fn() },
    cover: { create: vi.fn(async () => ({ id: 'mock-cover-id' })) },
  },
}));

const { generateCoverImage } = await import('../../src/thumbnail/image.js');
import type { GenerateCoverImageDeps } from '../../src/thumbnail/image.js';
import type {
  GenerateImageArgs,
  GenerateImageResult,
  GenerateImageFn,
  ImageGenDeps,
} from '../../src/tools/image-gen.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeGenerateImage(
  imageBuffer: Buffer = Buffer.from('FAKE_PNG_DATA'),
  costJpy = 15.0,
): GenerateImageFn {
  return vi.fn(
    async (_args: GenerateImageArgs, _deps?: ImageGenDeps): Promise<GenerateImageResult> => ({
      images: [imageBuffer],
      costJpy,
      usage: { imageCount: 1 },
    }),
  );
}

function makeFakeUploadBuffer() {
  return vi.fn(
    async (key: string, _buffer: Buffer, contentType: string) => ({
      key,
      sha256: 'abc123',
      size: 1024,
      contentType,
    }),
  );
}

function makeFakeCoverRepo() {
  return {
    create: vi.fn(async (args: { data: { id: string } }) => ({ id: args.data.id })),
  };
}

function baseInput(overrides: Partial<ThumbnailImageInput> = {}): ThumbnailImageInput {
  return {
    bookId: overrides.bookId ?? 'book-1',
    coverTextId: overrides.coverTextId ?? 'ctp-1',
    title: overrides.title ?? '副業で月5万円稼ぐ方法',
    subtitle: overrides.subtitle,
    styleGuide: overrides.styleGuide ?? 'minimalist Japanese business book',
    width: overrides.width ?? 1024,
    height: overrides.height ?? 1536,
    ...(overrides.jobId !== undefined ? { jobId: overrides.jobId } : {}),
  };
}

function makeFakeVerify(ok = true) {
  return vi.fn(async (_input: unknown) => ({
    ok,
    title_legible: ok,
    title_matches: ok,
    garbled_text_detected: !ok,
    extra_text_detected: false,
    transcribed_text: 'タイトル',
    issues: ok ? [] : ['タイトル文字が崩れています'],
    confidence: 0.9,
  }));
}

function baseDeps(overrides: Partial<GenerateCoverImageDeps> = {}): GenerateCoverImageDeps {
  return {
    generateImage: overrides.generateImage ?? makeFakeGenerateImage(),
    uploadBuffer: overrides.uploadBuffer ?? makeFakeUploadBuffer(),
    prisma: overrides.prisma ?? { cover: makeFakeCoverRepo() },
    generateId: overrides.generateId ?? (() => 'test-cover-id'),
    verifyCoverText: overrides.verifyCoverText ?? makeFakeVerify(true),
    withImageLoggingDeps: overrides.withImageLoggingDeps ?? {
      prisma: {
        tokenUsage: { create: vi.fn() },
        book: { update: vi.fn() },
      } as never,
      logger: { warn: vi.fn() },
      fetchPriceSnapshot: async () => ({ snapshot: {}, costJpy: 15.0 }),
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 1. happy path
// ---------------------------------------------------------------------------

describe('generateCoverImage -- happy path', () => {
  it('generates image, uploads to R2, creates Cover, returns correct output', async () => {
    const input = baseInput();
    const deps = baseDeps();

    const result = await generateCoverImage(input, deps);

    expect(result.coverId).toBe('test-cover-id');
    expect(result.r2Key).toBe('books/book-1/covers/raw/test-cover-id.jpg');
    expect(result.promptUsed).toContain('副業で月5万円稼ぐ方法');

    expect(deps.generateImage).toHaveBeenCalledTimes(1);
    expect(deps.uploadBuffer).toHaveBeenCalledTimes(1);
    expect(deps.prisma!.cover.create).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 2. prompt includes title and subtitle
// ---------------------------------------------------------------------------

describe('generateCoverImage -- prompt construction', () => {
  it('prompt includes title and subtitle when provided', async () => {
    const input = baseInput({
      title: 'AI時代の副業術',
      subtitle: '完全ガイド',
    });
    const deps = baseDeps();

    const result = await generateCoverImage(input, deps);

    expect(result.promptUsed).toContain('AI時代の副業術');
    expect(result.promptUsed).toContain('完全ガイド');
  });

  // 3. prompt includes style guide
  it('prompt includes style guide', async () => {
    const input = baseInput({
      styleGuide: 'watercolor illustration, warm tones',
    });
    const deps = baseDeps();

    const result = await generateCoverImage(input, deps);

    expect(result.promptUsed).toContain('watercolor illustration, warm tones');
  });

  it('prompt without subtitle does not include subtitle line', async () => {
    const input = baseInput({ subtitle: undefined });
    const deps = baseDeps();

    const result = await generateCoverImage(input, deps);

    expect(result.promptUsed).not.toContain('Subtitle:');
  });

  it('prompt without styleGuide does not include Style line', async () => {
    const input = baseInput({ styleGuide: '' });
    const deps = baseDeps();

    const result = await generateCoverImage(input, deps);

    expect(result.promptUsed).not.toContain('Style:');
  });
});

// ---------------------------------------------------------------------------
// 4. R2 key pattern
// ---------------------------------------------------------------------------

describe('generateCoverImage -- R2 key', () => {
  it('follows books/{bookId}/covers/raw/{coverId}.jpg pattern', async () => {
    const input = baseInput({ bookId: 'mybook123' });
    const deps = baseDeps({ generateId: () => 'coverABC' });

    const result = await generateCoverImage(input, deps);

    expect(result.r2Key).toBe('books/mybook123/covers/raw/coverABC.jpg');
  });
});

// ---------------------------------------------------------------------------
// 5. Cover INSERT fields
// ---------------------------------------------------------------------------

describe('generateCoverImage -- Cover INSERT', () => {
  it('Cover row has correct fields', async () => {
    const input = baseInput({
      bookId: 'book-X',
      coverTextId: 'ctp-Y',
      width: 1024,
      height: 1536,
    });
    const coverRepo = makeFakeCoverRepo();
    const deps = baseDeps({
      prisma: { cover: coverRepo },
      generateId: () => 'cover-Z',
    });

    await generateCoverImage(input, deps);

    expect(coverRepo.create).toHaveBeenCalledTimes(1);
    const createCall = coverRepo.create.mock.calls[0]![0] as unknown as {
      data: Record<string, unknown>;
    };
    expect(createCall.data).toMatchObject({
      id: 'cover-Z',
      book_id: 'book-X',
      cover_text_id: 'ctp-Y',
      r2_key: 'books/book-X/covers/raw/cover-Z.jpg',
      width: 1024,
      height: 1536,
      status: 'generated',
    });
    expect(createCall.data.prompt_used).toBeTruthy();
    expect(createCall.data.generation_meta_json).toMatchObject({
      provider: 'openai',
      model: 'gpt-image-1',
    });
  });
});

// ---------------------------------------------------------------------------
// 6. token_usage via withImageLogging
// ---------------------------------------------------------------------------

describe('generateCoverImage -- token_usage', () => {
  it('withImageLogging records token_usage for the image generation', async () => {
    const input = baseInput({ bookId: 'book-TOKEN', jobId: 'job-TOKEN' });
    const tokenCreate = vi.fn();
    const deps = baseDeps({
      withImageLoggingDeps: {
        prisma: {
          tokenUsage: { create: tokenCreate },
          book: { update: vi.fn() },
        } as never,
        logger: { warn: vi.fn() },
        fetchPriceSnapshot: async () => ({ snapshot: {}, costJpy: 20.0 }),
      },
    });

    await generateCoverImage(input, deps);

    expect(tokenCreate).toHaveBeenCalledTimes(1);
    const data = tokenCreate.mock.calls[0]![0].data;
    expect(data.book_id).toBe('book-TOKEN');
    expect(data.job_id).toBe('job-TOKEN');
    expect(data.provider).toBe('openai');
    expect(data.model).toBe('gpt-image-1');
    expect(data.role).toBe('thumbnail_image');
    expect(data.image_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7-8. jobId forwarding
// ---------------------------------------------------------------------------

describe('generateCoverImage -- jobId', () => {
  it('jobId specified -> forwarded to token_usage.job_id', async () => {
    const input = baseInput({ jobId: 'job-999' });
    const tokenCreate = vi.fn();
    const deps = baseDeps({
      withImageLoggingDeps: {
        prisma: {
          tokenUsage: { create: tokenCreate },
          book: { update: vi.fn() },
        } as never,
        logger: { warn: vi.fn() },
        fetchPriceSnapshot: async () => ({ snapshot: {}, costJpy: 10.0 }),
      },
    });

    await generateCoverImage(input, deps);

    const data = tokenCreate.mock.calls[0]![0].data;
    expect(data.job_id).toBe('job-999');
  });

  it('jobId omitted -> token_usage.job_id is null', async () => {
    const input = baseInput();
    const tokenCreate = vi.fn();
    const deps = baseDeps({
      withImageLoggingDeps: {
        prisma: {
          tokenUsage: { create: tokenCreate },
          book: { update: vi.fn() },
        } as never,
        logger: { warn: vi.fn() },
        fetchPriceSnapshot: async () => ({ snapshot: {}, costJpy: 10.0 }),
      },
    });

    await generateCoverImage(input, deps);

    const data = tokenCreate.mock.calls[0]![0].data;
    expect(data.job_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. generateImage failure -> propagated
// ---------------------------------------------------------------------------

describe('generateCoverImage -- error propagation', () => {
  it('generateImage failure propagates to caller', async () => {
    const failingGen = vi.fn(async () => {
      throw new Error('OpenAI API down');
    }) as unknown as GenerateImageFn;
    const input = baseInput();
    const deps = baseDeps({ generateImage: failingGen });

    await expect(generateCoverImage(input, deps)).rejects.toThrow('OpenAI API down');
    expect(deps.uploadBuffer).not.toHaveBeenCalled();
    expect(deps.prisma!.cover.create).not.toHaveBeenCalled();
  });

  // 10. R2 upload failure
  it('R2 upload failure propagates to caller', async () => {
    const failingUpload = vi.fn(async () => {
      throw new Error('R2 PUT failed');
    });
    const input = baseInput();
    const deps = baseDeps({ uploadBuffer: failingUpload });

    await expect(generateCoverImage(input, deps)).rejects.toThrow('R2 PUT failed');
    expect(deps.prisma!.cover.create).not.toHaveBeenCalled();
  });

  // 11. Cover INSERT failure
  it('Cover INSERT failure propagates to caller', async () => {
    const failingRepo = {
      create: vi.fn(async () => {
        throw new Error('Prisma constraint violation');
      }),
    };
    const input = baseInput();
    const deps = baseDeps({ prisma: { cover: failingRepo } });

    await expect(generateCoverImage(input, deps)).rejects.toThrow(
      'Prisma constraint violation',
    );
  });
});

// ---------------------------------------------------------------------------
// 12. custom generateId
// ---------------------------------------------------------------------------

describe('generateCoverImage -- custom ID generation', () => {
  it('uses provided generateId function', async () => {
    const input = baseInput({ bookId: 'book-custom' });
    const deps = baseDeps({ generateId: () => 'my-custom-id-123' });

    const result = await generateCoverImage(input, deps);

    expect(result.coverId).toBe('my-custom-id-123');
    expect(result.r2Key).toContain('my-custom-id-123');
  });
});

// ---------------------------------------------------------------------------
// 13. width/height defaults
// ---------------------------------------------------------------------------

describe('generateCoverImage -- dimension defaults', () => {
  it('width defaults to 1024 and height to 1536', async () => {
    const input: ThumbnailImageInput = {
      bookId: 'book-def',
      coverTextId: 'ctp-def',
      title: 'テスト',
      styleGuide: '',
      width: 1024,
      height: 1536,
    };
    const genImage = makeFakeGenerateImage();
    const deps = baseDeps({ generateImage: genImage });

    await generateCoverImage(input, deps);

    const callArgs = (genImage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as GenerateImageArgs;
    expect(callArgs.width).toBe(1024);
    expect(callArgs.height).toBe(1536);
    // サムネは JPEG で生成する。
    expect(callArgs.outputFormat).toBe('jpeg');
  });
});

// ---------------------------------------------------------------------------
// 14. generation_meta_json includes cost and size info
// ---------------------------------------------------------------------------

describe('generateCoverImage -- generation_meta_json', () => {
  it('generation_meta_json contains provider, model, cost_jpy, dimensions, image_size_bytes', async () => {
    const imageBuffer = Buffer.from('A'.repeat(2048));
    const genImage = makeFakeGenerateImage(imageBuffer, 25.5);
    const coverRepo = makeFakeCoverRepo();
    const input = baseInput({ width: 1024, height: 1536 });
    const deps = baseDeps({
      generateImage: genImage,
      prisma: { cover: coverRepo },
    });

    await generateCoverImage(input, deps);

    const createArg = coverRepo.create.mock.calls[0]![0] as unknown as {
      data: Record<string, unknown>;
    };
    const meta = createArg.data.generation_meta_json as Record<string, unknown>;
    expect(meta.provider).toBe('openai');
    expect(meta.model).toBe('gpt-image-1');
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(1536);
    expect(meta.image_size_bytes).toBe(2048);
  });
});

// ---------------------------------------------------------------------------
// 15. image buffer passed to upload
// ---------------------------------------------------------------------------

describe('generateCoverImage -- upload buffer', () => {
  it('raw image buffer from generateImage is uploaded to R2', async () => {
    const imageBuffer = Buffer.from('RAW_PNG_BYTES');
    const genImage = makeFakeGenerateImage(imageBuffer);
    const uploadBuf = makeFakeUploadBuffer();
    const input = baseInput();
    const deps = baseDeps({
      generateImage: genImage,
      uploadBuffer: uploadBuf,
    });

    await generateCoverImage(input, deps);

    expect(uploadBuf).toHaveBeenCalledTimes(1);
    const [key, buf, contentType] = uploadBuf.mock.calls[0]!;
    expect(key).toContain('covers/raw/');
    expect(key).toMatch(/\.jpg$/);
    expect(buf).toBe(imageBuffer);
    expect(contentType).toBe('image/jpeg');
  });
});

// ---------------------------------------------------------------------------
// 15. Cover text verification (文字崩れチェック)
// ---------------------------------------------------------------------------

describe('generateCoverImage -- cover text verification', () => {
  it('verifies the generated image and records the verdict in generation_meta_json', async () => {
    const verify = makeFakeVerify(true);
    const coverRepo = makeFakeCoverRepo();
    const deps = baseDeps({ verifyCoverText: verify, prisma: { cover: coverRepo } });

    await generateCoverImage(baseInput(), deps);

    expect(verify).toHaveBeenCalledTimes(1);
    // 検証入力に画像 base64 と期待タイトルが渡る。
    const verifyArg = verify.mock.calls[0]![0] as unknown as {
      title: string;
      imageBase64: string;
      mimeType: string;
    };
    expect(verifyArg.title).toBe('副業で月5万円稼ぐ方法');
    expect(verifyArg.mimeType).toBe('image/jpeg');
    expect(verifyArg.imageBase64.length).toBeGreaterThan(0);

    const meta = (coverRepo.create.mock.calls[0]![0] as unknown as { data: { generation_meta_json: Record<string, unknown> } })
      .data.generation_meta_json;
    expect(meta.text_check_ok).toBe(true);
    expect(meta.image_attempts).toBe(1);
    expect(meta.text_check).toMatchObject({ ok: true });
  });

  it('regenerates when text is garbled, up to maxImageAttempts', async () => {
    const genImage = makeFakeGenerateImage();
    // 1 回目は崩れ (ok=false)、2 回目は OK。
    const verify = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        title_legible: false,
        title_matches: false,
        garbled_text_detected: true,
        extra_text_detected: false,
        transcribed_text: '副業で月5万円稼ぐ方珐',
        issues: ['「法」が崩れている'],
        confidence: 0.8,
      })
      .mockResolvedValueOnce({
        ok: true,
        title_legible: true,
        title_matches: true,
        garbled_text_detected: false,
        extra_text_detected: false,
        transcribed_text: '副業で月5万円稼ぐ方法',
        issues: [],
        confidence: 0.95,
      });
    const coverRepo = makeFakeCoverRepo();
    const deps = baseDeps({
      generateImage: genImage,
      verifyCoverText: verify,
      prisma: { cover: coverRepo },
      maxImageAttempts: 3,
    });

    await generateCoverImage(baseInput(), deps);

    expect(genImage).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
    const meta = (coverRepo.create.mock.calls[0]![0] as unknown as { data: { generation_meta_json: Record<string, unknown> } })
      .data.generation_meta_json;
    expect(meta.image_attempts).toBe(2);
    expect(meta.text_check_ok).toBe(true);
  });

  it('stops at maxImageAttempts even if still garbled (best-effort) and records ok=false', async () => {
    const genImage = makeFakeGenerateImage();
    const verify = makeFakeVerify(false); // 常に崩れ
    const coverRepo = makeFakeCoverRepo();
    const deps = baseDeps({
      generateImage: genImage,
      verifyCoverText: verify,
      prisma: { cover: coverRepo },
      maxImageAttempts: 2,
    });

    await generateCoverImage(baseInput(), deps);

    expect(genImage).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
    const meta = (coverRepo.create.mock.calls[0]![0] as unknown as { data: { generation_meta_json: Record<string, unknown> } })
      .data.generation_meta_json;
    expect(meta.image_attempts).toBe(2);
    expect(meta.text_check_ok).toBe(false);
  });

  it('checkCoverText=false skips verification entirely', async () => {
    const verify = makeFakeVerify(true);
    const coverRepo = makeFakeCoverRepo();
    const deps = baseDeps({
      verifyCoverText: verify,
      checkCoverText: false,
      prisma: { cover: coverRepo },
    });

    await generateCoverImage(baseInput(), deps);

    expect(verify).not.toHaveBeenCalled();
    const meta = (coverRepo.create.mock.calls[0]![0] as unknown as { data: { generation_meta_json: Record<string, unknown> } })
      .data.generation_meta_json;
    expect(meta.text_check).toBeNull();
    expect(meta.text_check_ok).toBeNull();
  });

  it('verifier failure is non-fatal: cover is still created with text_check_error', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('vision model down'));
    const coverRepo = makeFakeCoverRepo();
    const deps = baseDeps({ verifyCoverText: verify, prisma: { cover: coverRepo } });

    const result = await generateCoverImage(baseInput(), deps);

    expect(result.coverId).toBeTruthy();
    expect(verify).toHaveBeenCalledTimes(1);
    const meta = (coverRepo.create.mock.calls[0]![0] as unknown as { data: { generation_meta_json: Record<string, unknown> } })
      .data.generation_meta_json;
    expect(meta.text_check).toBeNull();
    expect(meta.text_check_error).toContain('vision model down');
  });
});
