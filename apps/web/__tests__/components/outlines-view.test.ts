/**
 * outlines-view.ts のユニットテスト (T-04-08).
 *
 * 検証:
 *  - parseChapters: 非配列/破損要素の defensive 振る舞い
 *  - serializeOutlineRow: Date → ISO, chapters parse, total_target_chars 集計,
 *    Book join (genre は Book.theme から拾う) と status fallback
 *  - summarizeOutlines: pending 件数 / 総文字数 / 影響冊数
 *  - pickEligibleIds: pending_review のみ rows 順で抽出
 *  - formatGenre: ジャンル enum → 日本語ラベル / 未知は素通し
 *  - formatDateTime: ISO → "YYYY-MM-DD HH:mm" / 不正値は素通し
 */
import { describe, expect, it } from 'vitest';

import {
  formatDateTime,
  formatGenre,
  parseChapters,
  pickEligibleIds,
  serializeOutlineRow,
  summarizeOutlines,
  type OutlineRowSerialized,
} from '../../lib/outlines-view';

function chapter(overrides: Partial<{
  index: number;
  heading: string;
  summary: string;
  target_chars: number;
  subheadings: string[];
}> = {}) {
  return {
    index: 1,
    heading: '見出し',
    summary: '要旨',
    target_chars: 5000,
    subheadings: ['小見出し1', '小見出し2'],
    ...overrides,
  };
}

function rawRow(overrides: {
  id: string;
  status?: string;
  chapters_json?: unknown;
  /** book key を含めれば値がそのまま採用される (null も許可)。未指定なら default。 */
  book?: unknown;
}) {
  // 'book' キーが存在するか (null/undefined 含む) を判定するため `in` を使う
  const hasBookOverride = Object.prototype.hasOwnProperty.call(overrides, 'book');
  const defaultBook = {
    id: `book_${overrides.id}`,
    title: `タイトル ${overrides.id}`,
    account_id: 'acc_1',
    status: 'queued',
    theme: { genre: 'business' },
  };
  return {
    id: overrides.id,
    book_id: `book_${overrides.id}`,
    status: overrides.status ?? 'pending_review',
    reject_note: null,
    approved_at: null,
    created_at: new Date('2026-05-25T03:00:00.000Z'),
    updated_at: new Date('2026-05-25T03:05:00.000Z'),
    chapters_json: overrides.chapters_json ?? [chapter()],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    book: (hasBookOverride ? overrides.book : defaultBook) as any,
  };
}

describe('parseChapters', () => {
  it('非配列は空配列', () => {
    expect(parseChapters(null)).toEqual([]);
    expect(parseChapters(undefined)).toEqual([]);
    expect(parseChapters('xxx')).toEqual([]);
    expect(parseChapters({})).toEqual([]);
  });

  it('要素単位で safeParse — 破損要素はスキップ', () => {
    const out = parseChapters([
      chapter({ heading: 'A' }),
      { foo: 'bar' }, // heading 欠落 → 除外
      chapter({ heading: 'B', target_chars: 3000 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.heading).toBe('A');
    expect(out[1]?.heading).toBe('B');
  });

  it('target_chars / subheadings / summary / index 欠落でも heading があれば残す', () => {
    const out = parseChapters([{ heading: 'minimal' }]);
    expect(out).toHaveLength(1);
    expect(out[0]?.heading).toBe('minimal');
    expect(out[0]?.target_chars).toBeUndefined();
    expect(out[0]?.subheadings).toBeUndefined();
  });
});

describe('serializeOutlineRow', () => {
  it('Date → ISO / chapters parse / target_chars 合計 / Book.theme.genre 拾い', () => {
    const r = serializeOutlineRow(
      rawRow({
        id: 'o1',
        chapters_json: [
          chapter({ index: 1, target_chars: 5000 }),
          chapter({ index: 2, target_chars: 6000 }),
        ],
      }),
    );
    expect(r.id).toBe('o1');
    expect(r.status).toBe('pending_review');
    expect(r.created_at).toBe('2026-05-25T03:00:00.000Z');
    expect(r.updated_at).toBe('2026-05-25T03:05:00.000Z');
    expect(r.chapters).toHaveLength(2);
    expect(r.total_target_chars).toBe(11000);
    expect(r.book?.title).toBe('タイトル o1');
    expect(r.book?.genre).toBe('business');
  });

  it('chapters_json が壊れていても total_target_chars=0 で安全に返す', () => {
    const r = serializeOutlineRow(
      rawRow({ id: 'o2', chapters_json: 'broken' }),
    );
    expect(r.chapters).toEqual([]);
    expect(r.total_target_chars).toBe(0);
  });

  it('未知 status は pending_review fallback', () => {
    const r = serializeOutlineRow(rawRow({ id: 'o3', status: 'weird_status' }));
    expect(r.status).toBe('pending_review');
  });

  it('既知 status は preserved', () => {
    expect(serializeOutlineRow(rawRow({ id: 'o4', status: 'approved' })).status).toBe(
      'approved',
    );
    expect(serializeOutlineRow(rawRow({ id: 'o5', status: 'rejected' })).status).toBe(
      'rejected',
    );
    expect(serializeOutlineRow(rawRow({ id: 'o6', status: 'draft' })).status).toBe(
      'draft',
    );
  });

  it('Book join が無い場合 book=null', () => {
    const r = serializeOutlineRow(rawRow({ id: 'o7', book: null }));
    expect(r.book).toBeNull();
  });

  it('target_chars 欠落の章は 0 扱いで合計に加算しない', () => {
    const r = serializeOutlineRow(
      rawRow({
        id: 'o8',
        chapters_json: [
          chapter({ target_chars: 5000 }),
          { heading: 'no chars' },
          chapter({ target_chars: 4000 }),
        ],
      }),
    );
    expect(r.chapters).toHaveLength(3);
    expect(r.total_target_chars).toBe(9000);
  });
});

describe('summarizeOutlines', () => {
  function mkRow(
    id: string,
    book_id: string,
    total: number,
  ): OutlineRowSerialized {
    return {
      id,
      book_id,
      status: 'pending_review',
      reject_note: null,
      approved_at: null,
      created_at: '2026-05-25T03:00:00.000Z',
      updated_at: '2026-05-25T03:00:00.000Z',
      chapters: [],
      total_target_chars: total,
      book: null,
    };
  }

  it('件数 / 総文字数 / 影響冊数 (book_id 重複は 1 件)', () => {
    const rows = [
      mkRow('o1', 'b1', 5000),
      mkRow('o2', 'b2', 6000),
      mkRow('o3', 'b3', 7000),
    ];
    expect(summarizeOutlines(rows)).toEqual({
      pending: 3,
      totalTargetChars: 18000,
      booksAffected: 3,
    });
  });

  it('空配列 → 全 0', () => {
    expect(summarizeOutlines([])).toEqual({
      pending: 0,
      totalTargetChars: 0,
      booksAffected: 0,
    });
  });
});

describe('pickEligibleIds', () => {
  function mkRow(
    id: string,
    status: OutlineRowSerialized['status'],
  ): OutlineRowSerialized {
    return {
      id,
      book_id: `b_${id}`,
      status,
      reject_note: null,
      approved_at: null,
      created_at: '2026-05-25T03:00:00.000Z',
      updated_at: '2026-05-25T03:00:00.000Z',
      chapters: [],
      total_target_chars: 0,
      book: null,
    };
  }

  it('pending_review のみ抽出し rows 順を保つ', () => {
    const rows = [
      mkRow('o1', 'pending_review'),
      mkRow('o2', 'approved'),
      mkRow('o3', 'pending_review'),
      mkRow('o4', 'rejected'),
    ];
    const sel = new Set(['o1', 'o2', 'o3', 'o4']);
    expect(pickEligibleIds(rows, sel)).toEqual(['o1', 'o3']);
  });

  it('未選択 ID は無視', () => {
    const rows = [mkRow('o1', 'pending_review'), mkRow('o2', 'pending_review')];
    expect(pickEligibleIds(rows, new Set(['o2']))).toEqual(['o2']);
  });
});

describe('formatGenre', () => {
  it('ジャンル enum → 日本語', () => {
    expect(formatGenre('practical')).toBe('実用書');
    expect(formatGenre('business')).toBe('ビジネス書');
    expect(formatGenre('self_help')).toBe('自己啓発');
  });

  it('未知ジャンルは raw を返す', () => {
    expect(formatGenre('unknown_genre')).toBe('unknown_genre');
  });

  it('null / undefined は null', () => {
    expect(formatGenre(null)).toBeNull();
    expect(formatGenre(undefined)).toBeNull();
  });
});

describe('formatDateTime', () => {
  it('ISO → YYYY-MM-DD HH:mm pattern (ローカル TZ 依存)', () => {
    expect(formatDateTime('2026-05-25T10:30:00.000Z')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
  });

  it('不正値はそのまま返す', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});
