import { ValidationError } from '@a2p/contracts/errors';

/**
 * R2 オブジェクトキー生成 (docs/05 §8 規約)
 *
 * 規約サマリ:
 *   - すべてのキーは小文字 + ハイフン。空白・全角文字禁止
 *   - book_id / account_id / cover_id は cuid(2) を想定 → URL-safe 英数字のみ
 *   - 削除は論理削除（呼び出し側で `_deleted/<original_key>` にリネーム）
 *
 * 本モジュールはキー文字列生成のみを担当する。R2 への読み書きは `operations.ts`。
 */

/** Prisma `@id @default(cuid())` で生成される ID 形式 (英数字 + 内部記号無し)。 */
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
/** YYYY-MM-DD (UTC or JST、保存側都合)。 */
const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** YYYY-MM。`archive/jobs/{yyyy-mm}.jsonl.gz` 用。 */
const YM_PATTERN = /^\d{4}-\d{2}$/;
/** ファイル名 (拡張子含む)。空白・全角・`/` `\` 禁止。 */
const FILENAME_PATTERN = /^[a-zA-Z0-9._-]{1,128}$/;
/** KDP 入稿ステップ名 (例: `login`, `metadata`, `upload`)。 */
const STEP_PATTERN = /^[a-z][a-z0-9_-]{0,32}$/;

function assertId(label: string, value: string): void {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ValidationError(`${label} が不正です (英数字/_-, 1-64 文字)`, {
      details: { label, value },
    });
  }
}

function assertFilename(value: string): void {
  if (typeof value !== 'string' || !FILENAME_PATTERN.test(value)) {
    throw new ValidationError('filename が不正です (英数字/._-, 1-128 文字)', {
      details: { value },
    });
  }
}

function assertYmd(value: string): void {
  if (typeof value !== 'string' || !YMD_PATTERN.test(value)) {
    throw new ValidationError('日付は YYYY-MM-DD 形式で指定してください', {
      details: { value },
    });
  }
}

function assertYm(value: string): void {
  if (typeof value !== 'string' || !YM_PATTERN.test(value)) {
    throw new ValidationError('年月は YYYY-MM 形式で指定してください', {
      details: { value },
    });
  }
}

function assertStep(value: string): void {
  if (typeof value !== 'string' || !STEP_PATTERN.test(value)) {
    throw new ValidationError('step は小文字英字始まりの 1-33 文字で指定してください', {
      details: { value },
    });
  }
}

function assertNonNegativeInt(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${label} は 0 以上の整数で指定してください`, {
      details: { label, value },
    });
  }
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

// ---------------------------------------------------------------------------
// docs/05 §8 主要キー生成関数
// ---------------------------------------------------------------------------

/** `Artifact.kind` のうち、書籍直下成果物の種別。 */
export type BookArtifactKind = 'docx' | 'pdf' | 'cover_png' | 'cover_source';

/**
 * 書籍成果物の R2 キーを生成する。
 *
 * - `docx`         → `books/{book_id}/manuscript/final.docx`
 * - `pdf`          → `books/{book_id}/manuscript/final.pdf`
 * - `cover_source` → `books/{book_id}/covers/raw/{filename}` (filename 必須、例: `<cover_id>.png`)
 * - `cover_png`    → `books/{book_id}/covers/kdp/{filename}` (filename 必須、例: `<cover_id>-2560x1600.png`)
 */
export function bookArtifact(
  bookId: string,
  kind: BookArtifactKind,
  filename?: string,
): string {
  assertId('bookId', bookId);
  switch (kind) {
    case 'docx':
      return `books/${bookId}/manuscript/final.docx`;
    case 'pdf':
      return `books/${bookId}/manuscript/final.pdf`;
    case 'cover_source': {
      if (!filename) {
        throw new ValidationError("kind='cover_source' は filename が必須です");
      }
      assertFilename(filename);
      return `books/${bookId}/covers/raw/${filename}`;
    }
    case 'cover_png': {
      if (!filename) {
        throw new ValidationError("kind='cover_png' は filename が必須です");
      }
      assertFilename(filename);
      return `books/${bookId}/covers/kdp/${filename}`;
    }
    default: {
      const exhaustive: never = kind;
      throw new ValidationError(`未知の bookArtifact kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * 章ドラフト (中間 Markdown) の R2 キー。docs/05 §8:
 * `books/{book_id}/manuscript/source/chapter-{nn}.md`
 */
export function chapterDraft(bookId: string, chapterIdx: number): string {
  assertId('bookId', bookId);
  assertNonNegativeInt('chapterIdx', chapterIdx);
  return `books/${bookId}/manuscript/source/chapter-${pad2(chapterIdx)}.md`;
}

/**
 * KDP 自動入稿失敗時のスクリーンショット (Phase 3, F-041)。
 * docs/05 §8: `books/{book_id}/kdp/screenshots/{job_id}-{step}.png`
 */
export function kdpScreenshot(bookId: string, jobId: string, step: string): string {
  assertId('bookId', bookId);
  assertId('jobId', jobId);
  assertStep(step);
  return `books/${bookId}/kdp/screenshots/${jobId}-${step}.png`;
}

// ---------------------------------------------------------------------------
// docs/05 §8 の補助キー (将来用、SP-01 範囲では unit test のみで利用)
// ---------------------------------------------------------------------------

/** `archive/jobs/{yyyy-mm}.jsonl.gz` — `archive.jobs` タスクが月次で書き出し。 */
export function jobsArchive(yearMonth: string): string {
  assertYm(yearMonth);
  return `archive/jobs/${yearMonth}.jsonl.gz`;
}

/** `catalog/snapshots/{yyyy-mm-dd}.json` — ModelCatalog 日次バックアップ。 */
export function catalogSnapshot(ymd: string): string {
  assertYmd(ymd);
  return `catalog/snapshots/${ymd}.json`;
}

/**
 * `archive/db/{yyyy-mm-dd}.sql.gz` — `archive.db.backup` タスクが週次で書き出す
 * Postgres ダンプ (R-12 緩和)。docs/05 §8 に正本記載。
 */
export function dbBackup(ymd: string): string {
  assertYmd(ymd);
  return `archive/db/${ymd}.sql.gz`;
}

/** `accounts/{account_id}/meta/avatar.png` — アカウントアバター (任意)。 */
export function accountAvatar(accountId: string): string {
  assertId('accountId', accountId);
  return `accounts/${accountId}/meta/avatar.png`;
}

/** 販促チャンネル種別 (F-057 の画像キー用)。 */
const CHANNEL_PATTERN = /^[a-z][a-z0-9_-]{0,32}$/;
function assertChannel(value: string): void {
  if (typeof value !== 'string' || !CHANNEL_PATTERN.test(value)) {
    throw new ValidationError('channel が不正です (小文字英字始まりの 1-33 文字)', {
      details: { value },
    });
  }
}

/**
 * `promotion/{channel}/meta/avatar.png` — SNS アカウントのアイコン (F-057)。
 * sns_strategist が生成し R2 に保存、UI が `<img>` で参照する。
 */
export function channelAvatar(channel: string): string {
  assertChannel(channel);
  return `promotion/${channel}/meta/avatar.png`;
}

/** `promotion/{channel}/meta/banner.jpg` — SNS カバー/ヘッダー (F-057)。育成投稿の IG メディアにも使うため JPEG。 */
export function channelBanner(channel: string): string {
  assertChannel(channel);
  return `promotion/${channel}/meta/banner.jpg`;
}

/** `books/{book_id}/promo/social.jpg` — IG/TikTok 販促投稿用 AI 生成画像 (F-058, JPEG=IG必須)。 */
export function bookPromoImage(bookId: string): string {
  assertId('bookId', bookId);
  return `books/${bookId}/promo/social.jpg`;
}

/**
 * 論理削除用のキー変換 (docs/05 §8.1: `r2_key` を `_deleted/...` にリネーム)。
 * 既に `_deleted/` 配下にある場合はそのまま返す。
 */
export function softDeletedKey(originalKey: string): string {
  if (originalKey.startsWith('_deleted/')) return originalKey;
  return `_deleted/${originalKey}`;
}
