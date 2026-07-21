/**
 * F-020b — タイトル/サブタイトル/著者名の読み (フリガナ) 生成 I/O contract。
 *
 * KDP 入稿ではタイトル・著者名などにカタカナのヨミ（フリガナ）とローマ字を
 * 入力する必要がある。AI でカタカナ読みを生成し、ローマ字は決定的な変換で
 * 算出する (ローマ字生成は LLM に任せない)。
 */
import { z } from 'zod';

export const ReadingsInputSchema = z.object({
  jobId: z.string().optional(),
  bookId: z.string(),
  genre: z.enum(['practical', 'business', 'self_help']).nullable().optional(),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  /** 著者名 (ペンネーム)。 */
  author: z.string().min(1),
  /** レーベル名 (任意)。KDP 入稿の出版社/レーベル欄の読み用。 */
  label: z.string().optional(),
});
export type ReadingsInput = z.infer<typeof ReadingsInputSchema>;

/**
 * LLM が返すのはカタカナ読みのみ。空文字は「読み無し/不要」を表す
 * (記号のみのサブタイトル等)。ローマ字はサーバ側で kana から変換する。
 */
export const ReadingsOutputSchema = z.object({
  title_kana: z.string(),
  subtitle_kana: z.string(),
  author_kana: z.string(),
  /** レーベル名のカタカナ読み (label 未指定なら空)。既存プロンプト互換のため既定 ''。 */
  label_kana: z.string().default(''),
});
export type ReadingsOutput = z.infer<typeof ReadingsOutputSchema>;
