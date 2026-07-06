/**
 * docs/05 ss6.3.4 / F-006 -- Thumbnail Designer (cover text) I/O contract.
 *
 * ThumbnailTextInput / ThumbnailTextOutput correspond to the schemas
 * defined in docs/05 ss6.3.4. Additional context fields (jobId, accountId,
 * genre, themeContext) follow the Writer / Editor pattern for token_usage
 * traceability and prompt placeholder injection.
 *
 * DB mapping:
 *  - Each proposal maps to a `CoverTextProposal` row (book_id, title, subtitle, band_copy, status='proposed').
 *  - INSERT is handled by the pipeline worker task (`pipeline.book.thumbnail.text`), not by the agent itself.
 */
import { z } from 'zod';

/** A single cover-text proposal (title + optional subtitle + optional band copy). */
export const CoverTextProposalSchema = z.object({
  title: z.string().min(1).max(200),
  subtitle: z.string().max(200).optional(),
  band_copy: z.string().max(300).optional(),
});
export type CoverTextProposal = z.infer<typeof CoverTextProposalSchema>;

/**
 * Input for `generateCoverText`.
 *
 * `count` controls how many proposals to request (3-5, default 3).
 * The agent prompt instructs the LLM to produce exactly `count` proposals;
 * the output schema enforces min 3 / max 5.
 */
export const ThumbnailTextInputSchema = z.object({
  /** graphile-worker.jobs.id -- worker only. */
  jobId: z.string().optional(),
  /** `Book.id` -- token_usage.book_id. */
  bookId: z.string(),
  /** `accounts.id`. */
  accountId: z.string(),
  /** Genre (null = all-genre default prompt fallback). */
  genre: z.enum(['practical', 'business', 'self_help']).nullable(),
  /** Theme context -- same minimal set as Writer / Editor. */
  themeContext: z.object({
    title: z.string().min(1).max(200),
    subtitle: z.string().min(1).max(200).optional(),
    hook: z.string().min(1).max(800),
    target_reader: z.string().min(1).max(300),
  }),
  /** Number of proposals to generate (3-5). */
  count: z.number().int().min(3).max(5).default(3),
});
export type ThumbnailTextInput = z.infer<typeof ThumbnailTextInputSchema>;

/**
 * Output of `generateCoverText`.
 *
 * Enforces 3-5 proposals via zod array bounds.
 */
export const ThumbnailTextOutputSchema = z.object({
  proposals: z.array(CoverTextProposalSchema).min(3).max(5),
});
export type ThumbnailTextOutput = z.infer<typeof ThumbnailTextOutputSchema>;

// ---------------------------------------------------------------------------
// Thumbnail Image (F-007) — docs/05 §6.3.4
// ---------------------------------------------------------------------------

/**
 * Input for `generateCoverImage`.
 *
 * `cover_text_id` links back to the CoverTextProposal that this image
 * visualises. `style_guide` is a free-form style instruction injected into
 * the image-gen prompt (e.g. "minimalist Japanese business book cover").
 */
export const ThumbnailImageInputSchema = z.object({
  /** graphile-worker.jobs.id -- worker only. */
  jobId: z.string().optional(),
  /** `Book.id` -- token_usage.book_id. */
  bookId: z.string(),
  /** `CoverTextProposal.id`. */
  coverTextId: z.string(),
  /** Cover text title (from the CoverTextProposal). */
  title: z.string().min(1),
  /** Cover text subtitle (optional). */
  subtitle: z.string().optional(),
  /** 著者名/ペンネーム (任意)。合成タイポグラフィで表紙下部に焼き込む。 */
  author: z.string().optional(),
  /**
   * Free-form style guidance for the image prompt.
   * cover_art_direction エージェントが生成した「売れる」アート方向性 (英語) を
   * ここに渡す。空なら generateCoverImage 側の汎用フォールバックを使う。
   */
  styleGuide: z.string().default(''),
  /** Target width (px). */
  width: z.number().int().positive().default(1024),
  /** Target height (px). */
  height: z.number().int().positive().default(1536),
});
export type ThumbnailImageInput = z.infer<typeof ThumbnailImageInputSchema>;

/**
 * Output of `generateCoverImage`.
 *
 * The raw image is uploaded to R2 and a Cover row is inserted in DB.
 * The caller (pipeline task) does not need to perform additional persistence.
 */
export const ThumbnailImageOutputSchema = z.object({
  /** R2 object key for the raw cover image. */
  r2Key: z.string(),
  /** The prompt actually sent to gpt-image-1. */
  promptUsed: z.string(),
  /** DB Cover.id of the newly created row. */
  coverId: z.string(),
});
export type ThumbnailImageOutput = z.infer<typeof ThumbnailImageOutputSchema>;

// ---------------------------------------------------------------------------
// Cover Text Check (F-007b) — 生成カバー画像のタイポグラフィ検証
// ---------------------------------------------------------------------------

/**
 * Input for `verifyCoverText` — 生成済みカバー画像に描画された日本語タイトルが
 * 崩れていない (mojibake / 余分な文字 / 判読不能) ことをビジョンモデルで検証する。
 */
export const CoverTextCheckInputSchema = z.object({
  /** graphile-worker.jobs.id -- worker only (token_usage trace)。 */
  jobId: z.string().optional(),
  /** `Book.id` -- token_usage.book_id。 */
  bookId: z.string(),
  /** Genre (null = 全ジャンル既定プロンプト fallback)。 */
  genre: z.enum(['practical', 'business', 'self_help']).nullable().optional(),
  /** カバーに描画されているはずのタイトル (verbatim 期待値)。 */
  title: z.string().min(1),
  /** カバーに描画されているはずの副題 (任意)。 */
  subtitle: z.string().optional(),
  /** 検証対象画像の base64 (data: プレフィックス無し)。 */
  imageBase64: z.string().min(1),
  /** 画像の MIME タイプ (例: image/jpeg)。 */
  mimeType: z.string().default('image/jpeg'),
});
export type CoverTextCheckInput = z.infer<typeof CoverTextCheckInputSchema>;

/**
 * Output of `verifyCoverText`.
 *
 * `ok` = タイトルが判読でき、期待タイトルと一致し、崩れた文字が無い、の総合判定。
 */
export const CoverTextCheckOutputSchema = z.object({
  /** 総合判定: タイトルが正しく読め、崩れ・余分文字が無いか。 */
  ok: z.boolean(),
  /** タイトル文字が判読可能か。 */
  title_legible: z.boolean(),
  /** 読み取れたタイトルが期待タイトルと一致するか。 */
  title_matches: z.boolean(),
  /** 崩れた/不正な/存在しない文字 (mojibake) が検出されたか。 */
  garbled_text_detected: z.boolean(),
  /** 期待していない余分なテキスト (偽の著者名・ロゴ・ラベル等) が描画されているか。 */
  extra_text_detected: z.boolean(),
  /** モデルが画像から実際に読み取った全テキスト。 */
  transcribed_text: z.string(),
  /** 問題点の箇条書き (日本語)。 */
  issues: z.array(z.string()),
  /** 判定の確信度 0-1。 */
  confidence: z.number().min(0).max(1),
});
export type CoverTextCheckOutput = z.infer<typeof CoverTextCheckOutputSchema>;

// ---------------------------------------------------------------------------
// Cover Art Direction — Marketer 目線で「売れる」表紙ビジュアル方向性を決める
// ---------------------------------------------------------------------------

/**
 * Input for `generateCoverArtDirection`。
 *
 * 本の企画 (title/hook/target_reader/genre) を渡し、ジャンル・読者に刺さる
 * 「売れる」表紙のアート方向性を `count` 案生成させる。画風は固定しない
 * (ラノベ風とは限らない) — 実用書なら写真的/ミニマル/タイポ主体、自己啓発なら
 * 象徴的なイメージ等、マーケ判断でベストな絵作りを選ばせる。
 */
export const CoverArtDirectionInputSchema = z.object({
  /** graphile-worker.jobs.id -- worker only。 */
  jobId: z.string().optional(),
  /** `Book.id` -- token_usage.book_id。 */
  bookId: z.string(),
  /** Genre (null = 全ジャンル既定プロンプト fallback)。 */
  genre: z.enum(['practical', 'business', 'self_help']).nullable(),
  /** 企画コンテキスト (thumbnail_text と同じ最小セット)。 */
  themeContext: z.object({
    title: z.string().min(1).max(200),
    subtitle: z.string().min(1).max(200).optional(),
    hook: z.string().min(1).max(800),
    target_reader: z.string().min(1).max(300),
  }),
  /** 生成する方向性の数 (3-5、既定 3 — テキスト案と 1:1 で対応)。 */
  count: z.number().int().min(3).max(5).default(3),
});
export type CoverArtDirectionInput = z.infer<typeof CoverArtDirectionInputSchema>;

/** 単一のアート方向性。`image_prompt` を gpt-image-1 に渡す (英語・文字なし)。 */
export const CoverArtDirectionItemSchema = z.object({
  /** この方向性が「売れる」理由の説明 (日本語・運営者向け)。 */
  concept: z.string().min(1).max(600),
  /**
   * gpt-image-1 に渡す実際のアートディレクション (英語)。
   * 画風・被写体・構図・雰囲気・配色を具体的に。文字は絶対に含めない指示は
   * generateCoverImage 側で付与するので、ここでは純粋に絵の内容を書く。
   */
  image_prompt: z.string().min(1).max(1500),
  /** 主要な配色 (任意・日本語/英語どちらでも)。 */
  palette: z.string().max(200).optional(),
  /** 画風ラベル (任意、例: "写真的" "ミニマル・タイポ" "3D レンダ" 等)。 */
  style_label: z.string().max(80).optional(),
});
export type CoverArtDirectionItem = z.infer<typeof CoverArtDirectionItemSchema>;

/** Output of `generateCoverArtDirection`。3-5 案。 */
export const CoverArtDirectionOutputSchema = z.object({
  directions: z.array(CoverArtDirectionItemSchema).min(3).max(5),
});
export type CoverArtDirectionOutput = z.infer<typeof CoverArtDirectionOutputSchema>;
