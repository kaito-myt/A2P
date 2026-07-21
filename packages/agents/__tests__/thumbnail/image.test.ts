/**
 * Thumbnail Designer (cover image) unit tests.
 *
 * 【文字化け根絶の新設計】gpt-image-1 は「文字なしイラスト」だけ生成し、
 * タイトル等は composeCoverTypography で実フォント合成する。全ての外部依存
 * (generateImage, composeTypography, R2 upload, Prisma, ID) は DI で注入する。
 *
 * Coverage:
 *  1. happy path: 生成 → 合成 → R2 upload → Cover INSERT → output shape
 *  2. prompt は「文字なし」指示 + アート方向性を含み、タイトルは含まない
 *  3. styleGuide (アート方向性) が prompt に入る
 *  4. title/subtitle/author が composeTypography に渡る
 *  5. R2 key パターン
 *  6. Cover INSERT フィールド (text_overlay=true)
 *  7. token_usage 記録
 *  8. jobId forwarding
 *  9. エラー伝播 (generateImage / compose / upload / cover insert)
 * 10. custom generateId
 * 11. width/height 既定 + JPEG
 * 12. generation_meta の image_size_bytes は合成後バッファ長
 * 13. 合成後バッファが R2 に upload される
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
import type {
  GenerateCoverImageDeps,
  ComposeTypographyFn,
} from '../../src/thumbnail/image.js';
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
  imageBuffer: Buffer = Buffer.from('FAKE_ILLUSTRATION'),
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

/** タイトル文言を埋め込んだ「合成後」バッファを返す fake。 */
function makeFakeCompose(): ComposeTypographyFn {
  return vi.fn(async (_img: Buffer, text) =>
    Buffer.from(`COMPOSITED:${text.title}:${text.subtitle ?? ''}:${text.author ?? ''}`),
  );
}

function makeFakeUploadBuffer() {
  return vi.fn(async (key: string, _buffer: Buffer, contentType: string) => ({
    key,
    sha256: 'abc123',
    size: 1024,
    contentType,
  }));
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
    author: overrides.author,
    styleGuide: overrides.styleGuide ?? 'minimalist Japanese business book',
    width: overrides.width ?? 1024,
    height: overrides.height ?? 1536,
    ...(overrides.jobId !== undefined ? { jobId: overrides.jobId } : {}),
  };
}

function baseDeps(overrides: Partial<GenerateCoverImageDeps> = {}): GenerateCoverImageDeps {
  return {
    generateImage: overrides.generateImage ?? makeFakeGenerateImage(),
    composeTypography: overrides.composeTypography ?? makeFakeCompose(),
    uploadBuffer: overrides.uploadBuffer ?? makeFakeUploadBuffer(),
    prisma: overrides.prisma ?? { cover: makeFakeCoverRepo() },
    generateId: overrides.generateId ?? (() => 'test-cover-id'),
    // 既定は再描画パスを OFF にして「合成版がそのまま最終」という従来セマンティクスを保つ。
    // 再描画パス自体は専用の describe で検証する。
    refineTypography: overrides.refineTypography ?? false,
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
  it('generates textless illustration, composites text, uploads, creates Cover', async () => {
    const input = baseInput();
    const deps = baseDeps();

    const result = await generateCoverImage(input, deps);

    expect(result.coverId).toBe('test-cover-id');
    expect(result.r2Key).toBe('books/book-1/covers/raw/test-cover-id.jpg');

    expect(deps.generateImage).toHaveBeenCalledTimes(1);
    expect(deps.composeTypography).toHaveBeenCalledTimes(1);
    expect(deps.uploadBuffer).toHaveBeenCalledTimes(1);
    expect(deps.prisma!.cover.create).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 2-3. prompt construction (textless, art-direction driven)
// ---------------------------------------------------------------------------

describe('generateCoverImage -- prompt construction', () => {
  it('prompt はタイトル文字を統合描画するよう埋め込む(1パス統合生成)', async () => {
    const input = baseInput({ title: 'AI時代の副業術', subtitle: '初心者ガイド', author: '宮田海斗' });
    const result = await generateCoverImage(input, baseDeps());

    // 文字ごとデザインさせる方式: タイトル/サブ/著者を正確に描くよう指示する。
    expect(result.promptUsed).toContain('AI時代の副業術');
    expect(result.promptUsed).toContain('初心者ガイド');
    expect(result.promptUsed).toContain('宮田海斗');
    expect(result.promptUsed).toContain('一字一句正確');
  });

  it('prompt includes the style guide (art direction)', async () => {
    const input = baseInput({ styleGuide: 'watercolor illustration, warm tones' });
    const result = await generateCoverImage(input, baseDeps());

    expect(result.promptUsed).toContain('watercolor illustration, warm tones');
  });

  it('empty styleGuide falls back to a generic art direction referencing the theme', async () => {
    const input = baseInput({ title: 'テーマX', styleGuide: '' });
    const result = await generateCoverImage(input, baseDeps());

    expect(result.promptUsed).toContain('テーマX');
  });
});

// ---------------------------------------------------------------------------
// 4. text passed to compositor
// ---------------------------------------------------------------------------

describe('generateCoverImage -- typography compositing', () => {
  it('passes title/subtitle/author to composeTypography', async () => {
    const compose = makeFakeCompose();
    const input = baseInput({
      title: 'メインタイトル',
      subtitle: 'サブ',
      author: 'ミヤタ カイト',
    });
    await generateCoverImage(input, baseDeps({ composeTypography: compose }));

    expect(compose).toHaveBeenCalledTimes(1);
    const [, text] = (compose as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(text).toMatchObject({
      title: 'メインタイトル',
      subtitle: 'サブ',
      author: 'ミヤタ カイト',
    });
  });

  it('omits subtitle/author when not provided', async () => {
    const compose = makeFakeCompose();
    const input = baseInput({ subtitle: undefined, author: undefined });
    await generateCoverImage(input, baseDeps({ composeTypography: compose }));

    const [, text] = (compose as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(text.subtitle).toBeUndefined();
    expect(text.author).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. R2 key pattern
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
// 6. Cover INSERT fields
// ---------------------------------------------------------------------------

describe('generateCoverImage -- Cover INSERT', () => {
  it('Cover row has correct fields incl text_overlay=true', async () => {
    const input = baseInput({ bookId: 'book-X', coverTextId: 'ctp-Y' });
    const coverRepo = makeFakeCoverRepo();
    const deps = baseDeps({ prisma: { cover: coverRepo }, generateId: () => 'cover-Z' });

    await generateCoverImage(input, deps);

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
      text_overlay: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 7. token_usage via withImageLogging
// ---------------------------------------------------------------------------

describe('generateCoverImage -- token_usage', () => {
  it('records token_usage for the image generation', async () => {
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
// 8. jobId forwarding
// ---------------------------------------------------------------------------

describe('generateCoverImage -- jobId', () => {
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
// 9. error propagation
// ---------------------------------------------------------------------------

describe('generateCoverImage -- error propagation', () => {
  it('generateImage failure propagates and skips compose/upload/insert', async () => {
    const failingGen = vi.fn(async () => {
      throw new Error('OpenAI API down');
    }) as unknown as GenerateImageFn;
    const deps = baseDeps({ generateImage: failingGen });

    await expect(generateCoverImage(baseInput(), deps)).rejects.toThrow('OpenAI API down');
    expect(deps.composeTypography).not.toHaveBeenCalled();
    expect(deps.uploadBuffer).not.toHaveBeenCalled();
    expect(deps.prisma!.cover.create).not.toHaveBeenCalled();
  });

  it('compose failure propagates and skips upload/insert', async () => {
    const failingCompose = vi.fn(async () => {
      throw new Error('sharp compose failed');
    }) as unknown as ComposeTypographyFn;
    const deps = baseDeps({ composeTypography: failingCompose });

    await expect(generateCoverImage(baseInput(), deps)).rejects.toThrow('sharp compose failed');
    expect(deps.uploadBuffer).not.toHaveBeenCalled();
    expect(deps.prisma!.cover.create).not.toHaveBeenCalled();
  });

  it('R2 upload failure propagates', async () => {
    const failingUpload = vi.fn(async () => {
      throw new Error('R2 PUT failed');
    });
    const deps = baseDeps({ uploadBuffer: failingUpload });

    await expect(generateCoverImage(baseInput(), deps)).rejects.toThrow('R2 PUT failed');
    expect(deps.prisma!.cover.create).not.toHaveBeenCalled();
  });

  it('Cover INSERT failure propagates', async () => {
    const failingRepo = {
      create: vi.fn(async () => {
        throw new Error('Prisma constraint violation');
      }),
    };
    const deps = baseDeps({ prisma: { cover: failingRepo } });

    await expect(generateCoverImage(baseInput(), deps)).rejects.toThrow(
      'Prisma constraint violation',
    );
  });
});

// ---------------------------------------------------------------------------
// 10. custom generateId
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
// 11. width/height defaults + JPEG
// ---------------------------------------------------------------------------

describe('generateCoverImage -- generation args', () => {
  it('passes width/height and JPEG output to generateImage', async () => {
    const genImage = makeFakeGenerateImage();
    const deps = baseDeps({ generateImage: genImage });

    await generateCoverImage(baseInput({ width: 1024, height: 1536 }), deps);

    const callArgs = (genImage as ReturnType<typeof vi.fn>).mock.calls[0]![0] as GenerateImageArgs;
    expect(callArgs.width).toBe(1024);
    expect(callArgs.height).toBe(1536);
    expect(callArgs.outputFormat).toBe('jpeg');
  });
});

// ---------------------------------------------------------------------------
// 12-13. composited buffer is uploaded, meta size reflects it
// ---------------------------------------------------------------------------

describe('generateCoverImage -- composited output', () => {
  it('uploads the composited buffer (not the raw illustration) and records its size', async () => {
    const illustration = Buffer.from('RAW_ILLUSTRATION_BYTES');
    const composited = Buffer.from('COMPOSITED_FINAL_COVER_BYTES');
    const genImage = makeFakeGenerateImage(illustration);
    const compose = vi.fn(async () => composited) as unknown as ComposeTypographyFn;
    const uploadBuf = makeFakeUploadBuffer();
    const coverRepo = makeFakeCoverRepo();
    const deps = baseDeps({
      generateImage: genImage,
      composeTypography: compose,
      uploadBuffer: uploadBuf,
      prisma: { cover: coverRepo },
    });

    await generateCoverImage(baseInput(), deps);

    const [key, buf, contentType] = uploadBuf.mock.calls[0]!;
    expect(key).toMatch(/covers\/raw\/.*\.jpg$/);
    expect(buf).toBe(composited);
    expect(contentType).toBe('image/jpeg');

    const meta = (coverRepo.create.mock.calls[0]![0] as unknown as {
      data: { generation_meta_json: Record<string, unknown> };
    }).data.generation_meta_json;
    expect(meta.image_size_bytes).toBe(composited.byteLength);
    expect(meta.format).toBe('jpeg');
  });
});

// ---------------------------------------------------------------------------
// 14. typography refine pass (gpt-image-1 edit)
// ---------------------------------------------------------------------------

describe('generateCoverImage -- 1パス統合生成 (文字ごとデザイン)', () => {
  it('composeTypography 未注入なら合成せず、生成画像をそのまま最終カバーに使う', async () => {
    const uploadBuf = makeFakeUploadBuffer();
    const coverRepo = makeFakeCoverRepo();
    // 生成画像バッファを固定して、そのままアップロードされることを確認。
    const genImage = vi.fn(
      async (_args: GenerateImageArgs): Promise<GenerateImageResult> => ({
        images: [Buffer.from('INTEGRATED_COVER')],
        costJpy: 20.0,
        usage: { imageCount: 1 },
      }),
    ) as unknown as GenerateImageFn;

    await generateCoverImage(
      baseInput({ title: 'メインタイトル', subtitle: 'サブ', author: 'ミヤタ' }),
      // composeTypography を明示的に外す(未注入=合成なし)。
      baseDeps({ composeTypography: undefined, generateImage: genImage, uploadBuffer: uploadBuf, prisma: { cover: coverRepo } }),
    );

    // 合成せず生成画像がそのままアップロードされる。
    const [, buf] = uploadBuf.mock.calls[0]!;
    expect(buf.toString()).toBe('INTEGRATED_COVER');
    const meta = (coverRepo.create.mock.calls[0]![0] as unknown as {
      data: { generation_meta_json: Record<string, unknown> };
    }).data.generation_meta_json;
    expect(meta.typography_refined).toBe(false);
  });

  it('プロンプトに「読者の目に留まる」「KDPで売れる本の表紙」の意図が入る', async () => {
    const result = await generateCoverImage(baseInput({ title: 'テストタイトル' }), baseDeps());
    expect(result.promptUsed).toContain('読者の目に留まる');
    expect(result.promptUsed).toContain('KDP');
  });
});
