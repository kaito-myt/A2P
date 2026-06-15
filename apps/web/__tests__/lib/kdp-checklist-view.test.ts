/**
 * kdp-checklist-view.ts ユニットテスト (T-08-03).
 *
 * 検証:
 *  1. serializeChecklistBook: メタデータあり → フィールドが正しく構築される
 *  2. serializeChecklistBook: メタデータなし → metadataMissing=true / 全 value=null
 *  3. serializeChecklistBook: checklist_state_json の hydrate (copied/checked)
 *  4. computeOverallCompletion: checkedCount / readyCount 集計
 *  5. isBookReady: ブロック条件判定
 *  6. 価格フォーマット確認 (price フィールドは数字文字列)
 *  7. カバー URL: adopted ステータス優先
 *  8. must コメント フィルタリング (pending のみ)
 */
import { describe, expect, it } from 'vitest';

import {
  serializeChecklistBook,
  serializeChecklistPage,
  computeOverallCompletion,
  isBookReady,
  CHECKLIST_FIELDS,
  type PrismaBookForChecklist,
} from '../../lib/kdp-checklist-view';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_BOOK: PrismaBookForChecklist = {
  id: 'book_1',
  title: '副業 × AI で月 5 万円稼ぐ実践ガイド',
  subtitle: '初心者でも今日から始められる実践 7 ステップ',
  has_blocking_comments: false,
  account: { pen_name: 'テスト太郎' },
  kdpMetadata: {
    description: 'テスト用の紹介文です。本書は副業を始めたいけれど...',
    categories: ['ビジネス・経済 > 個人投資・副業', 'コンピュータ・IT > 人工知能'],
    keywords: ['副業', 'AI', 'ChatGPT', '月5万', '実践', '初心者', 'ガイド'],
    price_jpy: 499,
  },
  covers: [
    { id: 'cover_1', r2_key: 'covers/book_1/v1.png', status: 'adopted' },
    { id: 'cover_2', r2_key: 'covers/book_1/v2.png', status: 'generated' },
  ],
  artifacts: [
    { id: 'art_1', kind: 'docx', r2_key: 'artifacts/book_1/body.docx' },
    { id: 'art_2', kind: 'pdf', r2_key: 'artifacts/book_1/body.pdf' },
    { id: 'art_3', kind: 'png_cover', r2_key: 'artifacts/book_1/cover.png' },
  ],
  kdpSubmissionProgress: {
    checklist_state_json: {
      title: { copied: true, checked: true, checked_at: '2026-06-05T10:00:00.000Z' },
      subtitle: { copied: false, checked: false },
    },
    updated_at: new Date('2026-06-05T10:00:00.000Z'),
  },
  revisionComments: [
    { id: 'rc_1', body: '第 3 章を修正', priority: 'must', status: 'pending', target_kind: 'chapter' },
    { id: 'rc_2', body: '表紙テキスト修正', priority: 'should', status: 'pending', target_kind: 'cover' },
    { id: 'rc_3', body: '適用済みのコメント', priority: 'must', status: 'applied', target_kind: 'chapter' },
  ],
};

// ---------------------------------------------------------------------------
// Test 1: フィールド構築 (メタデータあり)
// ---------------------------------------------------------------------------

describe('serializeChecklistBook — metadata present', () => {
  it('フィールド数が CHECKLIST_FIELDS と一致する', () => {
    const result = serializeChecklistBook(BASE_BOOK);
    expect(result.fields).toHaveLength(CHECKLIST_FIELDS.length);
  });

  it('title フィールドが書籍タイトルを返す', () => {
    const result = serializeChecklistBook(BASE_BOOK);
    const titleField = result.fields.find((f) => f.field === 'title')!;
    expect(titleField.value).toBe('副業 × AI で月 5 万円稼ぐ実践ガイド');
  });

  it('author フィールドがペンネームを返す', () => {
    const result = serializeChecklistBook(BASE_BOOK);
    const authorField = result.fields.find((f) => f.field === 'author')!;
    expect(authorField.value).toBe('テスト太郎');
  });

  it('category1/category2 が categories 配列から取得される', () => {
    const result = serializeChecklistBook(BASE_BOOK);
    const cat1 = result.fields.find((f) => f.field === 'category1')!;
    const cat2 = result.fields.find((f) => f.field === 'category2')!;
    expect(cat1.value).toBe('ビジネス・経済 > 個人投資・副業');
    expect(cat2.value).toBe('コンピュータ・IT > 人工知能');
  });

  it('keywords フィールドに chips 配列が含まれる', () => {
    const result = serializeChecklistBook(BASE_BOOK);
    const kwField = result.fields.find((f) => f.field === 'keywords')!;
    expect(kwField.keywords).toEqual(['副業', 'AI', 'ChatGPT', '月5万', '実践', '初心者', 'ガイド']);
    expect(kwField.value).toContain('副業');
  });

  it('price フィールドが文字列数値を返す', () => {
    const result = serializeChecklistBook(BASE_BOOK);
    const priceField = result.fields.find((f) => f.field === 'price')!;
    expect(priceField.value).toBe('499');
  });

  it('metadataMissing=false', () => {
    const result = serializeChecklistBook(BASE_BOOK);
    expect(result.metadataMissing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 2: メタデータなし
// ---------------------------------------------------------------------------

describe('serializeChecklistBook — metadata missing', () => {
  const bookNoMeta: PrismaBookForChecklist = { ...BASE_BOOK, kdpMetadata: null };

  it('metadataMissing=true', () => {
    const result = serializeChecklistBook(bookNoMeta);
    expect(result.metadataMissing).toBe(true);
  });

  it('メタデータ依存フィールド (description, price 等) の value が null', () => {
    const result = serializeChecklistBook(bookNoMeta);
    // メタデータ依存フィールド
    const metadataFields = ['description', 'category1', 'category2', 'keywords', 'price'];
    for (const field of metadataFields) {
      const f = result.fields.find((x) => x.field === field)!;
      expect(f.value).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: checklist_state_json の hydrate
// ---------------------------------------------------------------------------

describe('serializeChecklistBook — checklist state hydration', () => {
  it('title は checked=true / copied=true として返る', () => {
    const result = serializeChecklistBook(BASE_BOOK);
    const titleField = result.fields.find((f) => f.field === 'title')!;
    expect(titleField.checked).toBe(true);
    expect(titleField.copied).toBe(true);
    expect(titleField.checked_at).toBe('2026-06-05T10:00:00.000Z');
  });

  it('subtitle は checked=false / copied=false として返る', () => {
    const result = serializeChecklistBook(BASE_BOOK);
    const subtitleField = result.fields.find((f) => f.field === 'subtitle')!;
    expect(subtitleField.checked).toBe(false);
    expect(subtitleField.copied).toBe(false);
  });

  it('state がない price は checked=false / copied=false として返る', () => {
    const result = serializeChecklistBook(BASE_BOOK);
    const priceField = result.fields.find((f) => f.field === 'price')!;
    expect(priceField.checked).toBe(false);
    expect(priceField.copied).toBe(false);
  });

  it('lastSavedAt が ISO 文字列として返る', () => {
    const result = serializeChecklistBook(BASE_BOOK);
    expect(result.lastSavedAt).toBe('2026-06-05T10:00:00.000Z');
  });

  it('kdpSubmissionProgress がない場合は lastSavedAt=null', () => {
    const book = { ...BASE_BOOK, kdpSubmissionProgress: null };
    const result = serializeChecklistBook(book);
    expect(result.lastSavedAt).toBeNull();
  });

  it('checkedCount は checked=true のフィールド数を返す', () => {
    const result = serializeChecklistBook(BASE_BOOK);
    // title だけ checked=true
    expect(result.checkedCount).toBe(1);
    expect(result.totalFieldCount).toBe(CHECKLIST_FIELDS.length);
  });
});

// ---------------------------------------------------------------------------
// Test 4: computeOverallCompletion
// ---------------------------------------------------------------------------

describe('computeOverallCompletion', () => {
  it('複数書籍の checkedCount / readyCount を正しく集計する', () => {
    const book1 = serializeChecklistBook(BASE_BOOK); // checkedCount=1, !blocking
    const book2 = serializeChecklistBook({
      ...BASE_BOOK,
      id: 'book_2',
      has_blocking_comments: true,
      kdpSubmissionProgress: null,
    }); // checkedCount=0, blocking

    const result = computeOverallCompletion([book1, book2]);
    expect(result.checkedCount).toBe(1);
    expect(result.totalCount).toBe(CHECKLIST_FIELDS.length * 2);
    expect(result.readyCount).toBe(1); // book2 は blocking
  });

  it('空配列は全て 0', () => {
    const result = computeOverallCompletion([]);
    expect(result.checkedCount).toBe(0);
    expect(result.totalCount).toBe(0);
    expect(result.readyCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 5: isBookReady
// ---------------------------------------------------------------------------

describe('isBookReady', () => {
  it('blocking なし + metadata あり → true', () => {
    const book = serializeChecklistBook(BASE_BOOK);
    expect(isBookReady(book)).toBe(true);
  });

  it('blocking あり → false', () => {
    const book = serializeChecklistBook({ ...BASE_BOOK, has_blocking_comments: true });
    expect(isBookReady(book)).toBe(false);
  });

  it('metadata なし → false', () => {
    const book = serializeChecklistBook({ ...BASE_BOOK, kdpMetadata: null });
    expect(isBookReady(book)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 6: カバー URL — adopted 優先
// ---------------------------------------------------------------------------

describe('serializeChecklistBook — cover URL', () => {
  it('adopted ステータスのカバーを優先して URL に使う', () => {
    const result = serializeChecklistBook(BASE_BOOK);
    // adopted は cover_1
    expect(result.coverImageUrl).toBe('/api/covers/cover_1/image');
  });

  it('adopted がない場合は最初のカバーを使う', () => {
    const book = {
      ...BASE_BOOK,
      covers: [
        { id: 'cover_a', r2_key: 'covers/a.png', status: 'generated' },
        { id: 'cover_b', r2_key: 'covers/b.png', status: 'generated' },
      ],
    };
    const result = serializeChecklistBook(book);
    expect(result.coverImageUrl).toBe('/api/covers/cover_a/image');
  });

  it('カバーがない場合は null', () => {
    const book = { ...BASE_BOOK, covers: [] };
    const result = serializeChecklistBook(book);
    expect(result.coverImageUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 7: must コメント フィルタリング
// ---------------------------------------------------------------------------

describe('serializeChecklistBook — must comments filtering', () => {
  it('pending の must コメントのみ mustComments に含まれる', () => {
    const result = serializeChecklistBook(BASE_BOOK);
    // rc_1: must+pending → 含まれる
    // rc_2: should+pending → 含まれない
    // rc_3: must+applied → 含まれない
    expect(result.mustComments).toHaveLength(1);
    expect(result.mustComments[0]!.id).toBe('rc_1');
  });

  it('mustCommentCount が mustComments.length と一致する', () => {
    const result = serializeChecklistBook(BASE_BOOK);
    expect(result.mustCommentCount).toBe(result.mustComments.length);
  });
});

// ---------------------------------------------------------------------------
// Test 8: serializeChecklistPage
// ---------------------------------------------------------------------------

describe('serializeChecklistPage', () => {
  it('複数書籍を並行シリアライズして返す', () => {
    const books = [BASE_BOOK, { ...BASE_BOOK, id: 'book_2', title: '第 2 冊' }];
    const result = serializeChecklistPage(books);
    expect(result.books).toHaveLength(2);
    expect(result.books[0]!.id).toBe('book_1');
    expect(result.books[1]!.id).toBe('book_2');
  });
});
