/**
 * docs/05 §6.3.3 / F-005 — Editor エージェント (校閲 + AI 開示文挿入) の I/O 契約。
 *
 * 本ファイルには Editor (T-04-03) の入出力型を定義する。
 *
 * 設計判断 (Hard Rule #3 — DB / docs/05 §6.3.3 整合):
 *  - docs/05 既定 schema は `{book_id, chapters: [{index, heading, body_md}], feedback?}`
 *    入力 / `{chapters: [{index, body_md, diff_summary}], ai_disclosure_appended: bool}` 出力。
 *    本実装はその既定を完全踏襲しつつ、Writer (T-04-01/02) と一貫した拡張フィールド
 *    (jobId / accountId / genre / themeContext / aiDisclosureText) を追加する。
 *  - 入力 chapters は Writer 章執筆結果（DB `chapters` 行）を全章分まとめて渡す。
 *    Editor は全章統合校閲 + 巻末 AI 開示文挿入を担う。章数は F-003/F-004 整合で 7〜10。
 *  - `aiDisclosureText` は呼出側 (worker) が `AppSettings.ai_disclosure_text` から読み出して
 *    渡す。Editor は受け取った文字列を巻末挿入し、`ai_disclosure_appended: true` を返す。
 *    LLM が挿入を忘れた場合は呼出側で**強制挿入**する安全装置 (R-05 遵守)。
 *  - `feedback` は Writer chapter と同じ `RevisionFeedbackItemSchema` (priority 別) を流用。
 *    F-050 Revision Applier (docs/05 §6.3.6) が同形式で渡せる。
 *  - 出力 `chapters[].diff_summary` は主な修正点 (任意)。表記ゆれ / 文体混在検出警告を
 *    含む設計 (T-04-03 タスク詳細)。`heading` は入力と同じ値を echo (Writer が決めた章
 *    タイトルを Editor が改変しない契約)。
 *
 * 自動検証 (T-04-03 完了判定 / editBook 呼出側で強制):
 *  - 入力 / 出力ともに章数 7〜10 (zod min/max)
 *  - 出力 chapters の index が入力と一致 (順序維持)
 *  - 出力 chapters の章数が入力と一致
 *  - 各章 body_md が 500 字以上 (短縮しすぎ防止)
 *  - 最終章 body_md 末尾に aiDisclosureText が含まれる (未含なら強制挿入 + true 返却)
 */
import { z } from 'zod';
import { GenreValueSchema } from '../genres.js';
import { RevisionFeedbackItemSchema } from './writer.js';

/**
 * 入力 1 章分 — Writer chapter の最終出力 (`Chapter.body_md`) を受け取る。
 * body_md の min(500) は Writer chapter 出力 schema と同じ防衛線。
 */
export const EditorChapterInputSchema = z.object({
  /** 1 始まりの連番。Editor は同 index で出力を返す契約。 */
  index: z.number().int().min(1),
  /** 章見出し (`Chapter.heading`)。Editor は改変しない。 */
  heading: z.string().min(1).max(200),
  /** 章本文 Markdown。 */
  body_md: z.string().min(500),
});
export type EditorChapterInput = z.infer<typeof EditorChapterInputSchema>;

/**
 * Editor 入力。Writer chapter 全 N 章 + テーマ文脈 + AI 開示文 + feedback。
 *
 * 受入基準 (F-005 / docs/02 / R-05):
 *  - 全章校閲 (順序維持、index 一致)
 *  - AI 開示文を巻末挿入 (Editor 出力 ai_disclosure_appended=true、呼出側で強制保証)
 *  - feedback 反映 (F-050 連携)
 *  - token_usage 紐付け (jobId/bookId 経由)
 */
export const EditorInputSchema = z.object({
  /** graphile-worker.jobs.id — worker 経由呼出時のみ。未指定で token_usage.job_id=null。 */
  jobId: z.string().optional(),
  /** `Book.id` — token_usage.book_id 紐付け先。 */
  bookId: z.string(),
  /** `accounts.id` — Writer と同じく文脈として保持。 */
  accountId: z.string(),
  /** ジャンル (null = 全ジャンル既定プロンプト fallback)。 */
  genre: GenreValueSchema.nullable(),
  /** 採用テーマから派生する文脈 — Writer と同じ最小集合。 */
  themeContext: z.object({
    title: z.string().min(1).max(200),
    subtitle: z.string().min(1).max(200).optional(),
    hook: z.string().min(1).max(800),
    target_reader: z.string().min(1).max(300),
  }),
  /** Writer chapter 全 N 章。F-003/F-004 整合で 7〜10。 */
  chapters: z.array(EditorChapterInputSchema).min(7).max(10),
  /**
   * AI 開示文 (`AppSettings.ai_disclosure_text`)。呼出側 (worker) が DB から読み出して渡す。
   * Editor は受け取った文字列を巻末挿入する責務を負う。
   */
  aiDisclosureText: z.string().min(1).max(500),
  /** F-050 修正コメント反映 — Writer chapter と同じ priority 別構造化形式。 */
  feedback: z.array(RevisionFeedbackItemSchema).default([]),
});
export type EditorInput = z.infer<typeof EditorInputSchema>;

/**
 * 出力 1 章分 — 校閲後本文 + 主な修正点。
 *
 * - `index` は入力と一致 (順序維持)。呼出側で検証。
 * - `heading` は入力と一致 (Editor は章タイトルを改変しない契約)。
 * - `body_md` min(500) は Writer chapter と同じ防衛線。短縮しすぎ防止。
 * - `diff_summary` は主な修正点 (任意)。表記ゆれ / 文体混在検出警告を含む。
 */
export const EditorChapterOutputSchema = z.object({
  index: z.number().int().min(1),
  heading: z.string().min(1).max(200),
  body_md: z.string().min(500),
  diff_summary: z.string().max(2000).optional(),
});
export type EditorChapterOutput = z.infer<typeof EditorChapterOutputSchema>;

/**
 * Editor の最終出力。
 *
 * - chapters: 入力と同じ章数 (呼出側で検証)
 * - ai_disclosure_appended: 巻末挿入確認フラグ (R-05)。
 *   LLM が挿入を忘れた場合は呼出側で**強制挿入** + true で返却する安全装置。
 * - ai_disclosure_text: 実際に挿入された文字列 (監査用にエコー)。
 * - overall_notes: 任意の総評 (運営者向けメモ)。
 */
export const EditorOutputSchema = z.object({
  chapters: z.array(EditorChapterOutputSchema).min(7).max(10),
  ai_disclosure_appended: z.boolean(),
  ai_disclosure_text: z.string().min(1).max(500),
  overall_notes: z.string().max(2000).optional(),
});
export type EditorOutput = z.infer<typeof EditorOutputSchema>;
