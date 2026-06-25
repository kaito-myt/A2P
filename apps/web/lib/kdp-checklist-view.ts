/**
 * S-015 KDP 入稿チェックリスト RSC シリアライザ (T-08-03, F-020/F-040/F-049).
 *
 * Prisma Book (+ KdpMetadata + Cover + Artifact + KdpSubmissionProgress +
 * RevisionComment) を Client Component に渡せる plain-object に変換する。
 *
 * 仕様根拠: docs/04 S-015 / docs/05 §4.3.16 / SP-08 T-08-03
 */
import type { ChecklistStateJson, ChecklistFieldState } from './kdp-checklist-core';

// ---------------------------------------------------------------------------
// Field keys (docs/05 §4.3.16 / kdp-checklist-core.ts schema)
// ---------------------------------------------------------------------------

export const CHECKLIST_FIELDS = [
  'title',
  'subtitle',
  'author',
  'description',
  'category1',
  'category2',
  'keywords',
  'price',
  'cover_url',
  'body_url',
] as const;

export type ChecklistField = (typeof CHECKLIST_FIELDS)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChecklistFieldView {
  field: ChecklistField;
  /** 表示用ラベル (messages から引く) */
  label: string;
  /** コピー対象の値。null = メタデータ未生成 */
  value: string | null;
  /** キーワードのみ複数 chip 表示 */
  keywords?: string[];
  /** カバー/本文 URL はダウンロードも提供 */
  downloadUrl?: string | null;
  /** アーティファクト ID — download エンドポイント用 */
  artifactId?: string | null;
  copied: boolean;
  checked: boolean;
  checked_at?: string;
}

export interface MustCommentView {
  id: string;
  body: string;
  /** RevisionComment.target_kind */
  target_kind: string;
}

export interface ChecklistBookView {
  id: string;
  title: string;
  subtitle: string | null;
  author: string | null;
  /** Amazon 入稿/出版ステータス (unlisted=未対応 / submitted=入稿済み / published=出版済み) */
  publishStatus: 'unlisted' | 'submitted' | 'published';
  /** カバー画像 R2 キー → `/api/covers/{id}/image` */
  coverImageUrl: string | null;
  /** KdpMetadata.price_jpy */
  priceJpy: number | null;
  /** true = メタデータ生成が未完了 */
  metadataMissing: boolean;
  /** Book.has_blocking_comments */
  hasBlockingComments: boolean;
  mustCommentCount: number;
  mustComments: MustCommentView[];
  fields: ChecklistFieldView[];
  /** 最終自動保存タイムスタンプ (KdpSubmissionProgress.updated_at) */
  lastSavedAt: string | null;
  /** 完了フィールド数 */
  checkedCount: number;
  totalFieldCount: number;
}

export interface ChecklistPageData {
  books: ChecklistBookView[];
}

// ---------------------------------------------------------------------------
// Prisma input shapes (uses structural typing to avoid direct import of
// generated Prisma types which may differ between dev/prod)
// ---------------------------------------------------------------------------

export interface PrismaBookForChecklist {
  id: string;
  title: string;
  subtitle: string | null;
  publish_status: string;
  has_blocking_comments: boolean;
  account: {
    pen_name: string;
  };
  kdpMetadata: {
    description: string;
    categories: string[];
    keywords: string[];
    price_jpy: number;
  } | null;
  covers: Array<{
    id: string;
    r2_key: string;
    status: string;
  }>;
  artifacts: Array<{
    id: string;
    kind: string;
    r2_key: string;
  }>;
  kdpSubmissionProgress: {
    checklist_state_json: unknown;
    updated_at: Date;
  } | null;
  revisionComments: Array<{
    id: string;
    body: string;
    priority: string;
    status: string;
    target_kind: string;
  }>;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function parseChecklistState(raw: unknown): ChecklistStateJson {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as ChecklistStateJson;
}

function getFieldState(
  state: ChecklistStateJson,
  field: string,
): ChecklistFieldState {
  return state[field] ?? { copied: false, checked: false };
}

function getAdoptedCoverUrl(
  covers: PrismaBookForChecklist['covers'],
): { id: string; url: string } | null {
  const adopted = covers.find((c) => c.status === 'adopted') ?? covers[0];
  if (!adopted) return null;
  return {
    id: adopted.id,
    url: `/api/covers/${adopted.id}/image`,
  };
}

function getArtifactDownloadUrl(
  artifacts: PrismaBookForChecklist['artifacts'],
  kind: string,
): { id: string; downloadUrl: string } | null {
  const artifact = artifacts.find((a) => a.kind === kind);
  if (!artifact) return null;
  return {
    id: artifact.id,
    downloadUrl: `/api/artifacts/${artifact.id}/download`,
  };
}

/**
 * 書籍 1 冊のチェックリストフィールド一覧を構築する。
 * メタデータが未生成の場合は value=null で返す。
 */
function buildFields(
  book: PrismaBookForChecklist,
  state: ChecklistStateJson,
): ChecklistFieldView[] {
  const meta = book.kdpMetadata;
  const cover = getAdoptedCoverUrl(book.covers);
  const docxArtifact = getArtifactDownloadUrl(book.artifacts, 'docx');
  const pdfArtifact = getArtifactDownloadUrl(book.artifacts, 'pdf');

  const fields: ChecklistFieldView[] = CHECKLIST_FIELDS.map((field): ChecklistFieldView => {
    const s = getFieldState(state, field);
    const base = {
      field,
      label: fieldLabel(field),
      copied: s.copied,
      checked: s.checked,
      checked_at: s.checked_at,
    };

    switch (field) {
      case 'title':
        return { ...base, value: meta ? book.title : null };
      case 'subtitle':
        return { ...base, value: meta ? (book.subtitle ?? '') : null };
      case 'author':
        return { ...base, value: meta ? book.account.pen_name : null };
      case 'description':
        return { ...base, value: meta ? meta.description : null };
      case 'category1':
        return { ...base, value: meta ? (meta.categories[0] ?? '') : null };
      case 'category2':
        return { ...base, value: meta ? (meta.categories[1] ?? '') : null };
      case 'keywords':
        return {
          ...base,
          value: meta ? meta.keywords.join(' ') : null,
          keywords: meta ? meta.keywords : undefined,
        };
      case 'price':
        return { ...base, value: meta ? String(meta.price_jpy) : null };
      case 'cover_url':
        return {
          ...base,
          value: cover?.url ?? null,
          downloadUrl: cover?.url ?? null,
          artifactId: null,
        };
      case 'body_url': {
        // docx を優先し、なければ pdf
        const artifact = docxArtifact ?? pdfArtifact;
        return {
          ...base,
          value: artifact?.downloadUrl ?? null,
          downloadUrl: artifact?.downloadUrl ?? null,
          artifactId: artifact?.id ?? null,
        };
      }
    }
  });

  return fields;
}

function fieldLabel(field: ChecklistField): string {
  const labels: Record<ChecklistField, string> = {
    title: 'タイトル',
    subtitle: 'サブタイトル',
    author: '著者名',
    description: '紹介文',
    category1: 'カテゴリ 1',
    category2: 'カテゴリ 2',
    keywords: 'キーワード (1-7)',
    price: '価格 (JPY)',
    cover_url: 'カバー URL',
    body_url: '本文 URL (docx/pdf)',
  };
  return labels[field];
}

export function serializeChecklistBook(
  book: PrismaBookForChecklist,
): ChecklistBookView {
  const state = parseChecklistState(book.kdpSubmissionProgress?.checklist_state_json);
  const fields = buildFields(book, state);
  const checkedCount = fields.filter((f) => f.checked).length;
  const totalFieldCount = CHECKLIST_FIELDS.length;

  const metadataMissing = book.kdpMetadata === null;

  const mustComments = book.revisionComments
    .filter((c) => c.priority === 'must' && c.status === 'pending')
    .map((c) => ({
      id: c.id,
      body: c.body,
      target_kind: c.target_kind,
    }));

  const cover = getAdoptedCoverUrl(book.covers);

  return {
    id: book.id,
    title: book.title,
    subtitle: book.subtitle,
    author: book.account.pen_name,
    publishStatus:
      book.publish_status === 'published'
        ? 'published'
        : book.publish_status === 'submitted'
          ? 'submitted'
          : 'unlisted',
    coverImageUrl: cover?.url ?? null,
    priceJpy: book.kdpMetadata?.price_jpy ?? null,
    metadataMissing,
    // ブロック状態は「未消化 (pending) の must コメントが存在するか」で都度算出する。
    // 旧実装は Book.has_blocking_comments フラグを使っていたが、コメントを対応済みに
    // しても入稿チェックに「残コメントあり」が残る同期ズレがあった。実コメントから
    // 導出することで、対応済みになれば即座にブロック解除される。
    hasBlockingComments: mustComments.length > 0,
    mustCommentCount: mustComments.length,
    mustComments,
    fields,
    lastSavedAt: book.kdpSubmissionProgress?.updated_at instanceof Date
      ? book.kdpSubmissionProgress.updated_at.toISOString()
      : null,
    checkedCount,
    totalFieldCount,
  };
}

export function serializeChecklistPage(
  books: PrismaBookForChecklist[],
): ChecklistPageData {
  return {
    books: books.map(serializeChecklistBook),
  };
}

// ---------------------------------------------------------------------------
// Completion rate helpers (used in ActionBar and tests)
// ---------------------------------------------------------------------------

/**
 * Overall completion rate across all books.
 * Returns `{ checkedCount, totalCount }`.
 */
export function computeOverallCompletion(books: ChecklistBookView[]): {
  checkedCount: number;
  totalCount: number;
  readyCount: number;
} {
  let checkedCount = 0;
  let totalCount = 0;
  let readyCount = 0;
  for (const book of books) {
    checkedCount += book.checkedCount;
    totalCount += book.totalFieldCount;
    if (!book.hasBlockingComments && !book.metadataMissing) {
      readyCount += 1;
    }
  }
  return { checkedCount, totalCount, readyCount };
}

/**
 * Returns true when the book has no blocking comments AND metadata exists.
 */
export function isBookReady(book: ChecklistBookView): boolean {
  return !book.hasBlockingComments && !book.metadataMissing;
}
