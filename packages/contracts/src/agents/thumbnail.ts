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
  /** Free-form style guidance for the image prompt. */
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
