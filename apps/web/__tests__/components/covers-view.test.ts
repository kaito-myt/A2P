/**
 * covers-view.ts のユニットテスト (T-05-10).
 *
 * 検証:
 *  - serializeCover: Date → ISO, status fallback
 *  - serializeCoverTextProposal: Date → ISO, status fallback
 *  - serializeBookCoverGroup: Book + covers + proposals まとめ変換
 *  - summarizeCovers: pending 冊数 / 候補枚数
 *  - pickEligibleCoverIds: generated のみ / 1 book = 1 cover ID
 *  - booksWithGeneratedCovers: generated を持つ book のみ抽出
 *  - extractCoverCost / extractCoverModel: defensive extraction
 *  - formatGenre / formatDateTime: 既存パターンと同様
 */
import { describe, expect, it } from 'vitest';

import {
  serializeCover,
  serializeCoverTextProposal,
  serializeBookCoverGroup,
  summarizeCovers,
  pickEligibleCoverIds,
  booksWithGeneratedCovers,
  extractCoverCost,
  extractCoverModel,
  formatGenre,
  formatDateTime,
  type BookCoverGroup,
  type CoverRowSerialized,
} from '../../lib/covers-view';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeCoverRaw(overrides: Partial<{
  id: string;
  book_id: string;
  cover_text_id: string | null;
  r2_key: string;
  artifact_id: string | null;
  prompt_used: string;
  width: number;
  height: number;
  status: string;
  generation_meta_json: unknown;
  created_at: Date;
}> = {}) {
  return {
    id: overrides.id ?? 'cover_1',
    book_id: overrides.book_id ?? 'book_1',
    cover_text_id: overrides.cover_text_id ?? null,
    r2_key: overrides.r2_key ?? 'books/book_1/covers/raw/cover_1.png',
    artifact_id: overrides.artifact_id ?? null,
    prompt_used: overrides.prompt_used ?? 'test prompt',
    width: overrides.width ?? 1024,
    height: overrides.height ?? 1024,
    status: overrides.status ?? 'generated',
    generation_meta_json: overrides.generation_meta_json ?? { model: 'gpt-image-1', cost_jpy: 38 },
    created_at: overrides.created_at ?? new Date('2026-01-15T10:30:00Z'),
  };
}

function makeProposalRaw(overrides: Partial<{
  id: string;
  book_id: string;
  title: string;
  subtitle: string | null;
  band_copy: string | null;
  status: string;
  created_at: Date;
}> = {}) {
  return {
    id: overrides.id ?? 'ctp_1',
    book_id: overrides.book_id ?? 'book_1',
    title: overrides.title ?? 'AI 副業入門',
    subtitle: overrides.subtitle ?? '月5万円稼ぐ方法',
    band_copy: overrides.band_copy ?? '売上シリーズ累計10万部突破',
    status: overrides.status ?? 'proposed',
    created_at: overrides.created_at ?? new Date('2026-01-15T10:00:00Z'),
  };
}

function makeBookCoverGroup(overrides: Partial<{
  bookId: string;
  title: string;
  genre: string | null;
  coverStatuses: string[];
  proposalCount: number;
}> = {}): BookCoverGroup {
  const bookId = overrides.bookId ?? 'book_1';
  const statuses = overrides.coverStatuses ?? ['generated', 'generated', 'generated'];
  const covers: CoverRowSerialized[] = statuses.map((s, i) => ({
    id: `${bookId}_cover_${i}`,
    book_id: bookId,
    cover_text_id: null,
    r2_key: `books/${bookId}/covers/raw/${i}.png`,
    artifact_id: null,
    prompt_used: 'prompt',
    width: 1024,
    height: 1024,
    status: s as CoverRowSerialized['status'],
    generation_meta_json: { model: 'gpt-image-1', cost_jpy: 38 },
    created_at: '2026-01-15T10:30:00.000Z',
  }));
  const proposals = Array.from({ length: overrides.proposalCount ?? 3 }, (_, i) => ({
    id: `${bookId}_ctp_${i}`,
    book_id: bookId,
    title: `Title ${i}`,
    subtitle: `Sub ${i}`,
    band_copy: null,
    status: 'proposed' as const,
    created_at: '2026-01-15T10:00:00.000Z',
  }));
  return {
    book: {
      id: bookId,
      title: overrides.title ?? 'Test Book',
      subtitle: null,
      account_id: 'acc_1',
      status: 'thumbnail',
      genre: overrides.genre ?? 'business',
    },
    covers,
    coverTextProposals: proposals,
    comments: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('serializeCover', () => {
  it('converts Date to ISO string and maps status', () => {
    const raw = makeCoverRaw({ status: 'adopted' });
    const result = serializeCover(raw);
    expect(result.status).toBe('adopted');
    expect(result.created_at).toBe('2026-01-15T10:30:00.000Z');
    expect(result.r2_key).toBe('books/book_1/covers/raw/cover_1.png');
  });

  it('falls back unknown status to generated', () => {
    const raw = makeCoverRaw({ status: 'unknown_status' });
    const result = serializeCover(raw);
    expect(result.status).toBe('generated');
  });
});

describe('serializeCoverTextProposal', () => {
  it('converts Date to ISO string', () => {
    const raw = makeProposalRaw();
    const result = serializeCoverTextProposal(raw);
    expect(result.created_at).toBe('2026-01-15T10:00:00.000Z');
    expect(result.title).toBe('AI 副業入門');
    expect(result.subtitle).toBe('月5万円稼ぐ方法');
  });

  it('falls back unknown status to proposed', () => {
    const raw = makeProposalRaw({ status: 'weird' });
    const result = serializeCoverTextProposal(raw);
    expect(result.status).toBe('proposed');
  });
});

describe('serializeBookCoverGroup', () => {
  it('serializes a book with covers and proposals', () => {
    const raw = {
      id: 'book_1',
      title: 'Test',
      subtitle: 'Sub',
      account_id: 'acc_1',
      status: 'thumbnail',
      theme: { genre: 'practical' },
      covers: [makeCoverRaw()],
      coverTextProposals: [makeProposalRaw()],
    };
    const result = serializeBookCoverGroup(raw);
    expect(result.book.id).toBe('book_1');
    expect(result.book.genre).toBe('practical');
    expect(result.covers).toHaveLength(1);
    expect(result.coverTextProposals).toHaveLength(1);
    expect(result.comments).toEqual([]);
  });

  it('handles null theme', () => {
    const raw = {
      id: 'book_2',
      title: 'No Theme',
      subtitle: null,
      account_id: 'acc_1',
      status: 'thumbnail',
      theme: null,
      covers: [],
      coverTextProposals: [],
    };
    const result = serializeBookCoverGroup(raw);
    expect(result.book.genre).toBeNull();
    expect(result.comments).toEqual([]);
  });

  it('serializes revisionComments and filters to cover/cover_text target_kind', () => {
    const raw = {
      id: 'book_3',
      title: 'With Comments',
      subtitle: null,
      account_id: 'acc_1',
      status: 'thumbnail',
      theme: null,
      covers: [makeCoverRaw({ id: 'c1', book_id: 'book_3' })],
      coverTextProposals: [],
      revisionComments: [
        {
          id: 'rc_1',
          book_id: 'book_3',
          target_kind: 'cover',
          target_id: 'c1',
          range_json: { image_region: { x: 0.1, y: 0.2, w: 0.2, h: 0.2 } },
          body: 'Fix color',
          priority: 'must',
          status: 'pending',
          created_at: new Date('2026-05-01T10:00:00Z'),
          applied_at: null,
        },
        {
          id: 'rc_2',
          book_id: 'book_3',
          target_kind: 'chapter',
          target_id: 'ch1',
          range_json: null,
          body: 'Fix text',
          priority: 'should',
          status: 'pending',
          created_at: new Date('2026-05-01T11:00:00Z'),
          applied_at: null,
        },
      ],
    };
    const result = serializeBookCoverGroup(raw);
    expect(result.comments).toHaveLength(1);
    const first = result.comments[0]!;
    expect(first.id).toBe('rc_1');
    expect(first.target_kind).toBe('cover');
    expect(first.created_at).toBe('2026-05-01T10:00:00.000Z');
  });
});

describe('summarizeCovers', () => {
  it('counts pending books and total generated covers', () => {
    const groups = [
      makeBookCoverGroup({ bookId: 'b1', coverStatuses: ['generated', 'generated', 'adopted'] }),
      makeBookCoverGroup({ bookId: 'b2', coverStatuses: ['adopted', 'rejected'] }),
      makeBookCoverGroup({ bookId: 'b3', coverStatuses: ['generated'] }),
    ];
    const summary = summarizeCovers(groups);
    expect(summary.pendingBooks).toBe(2);
    expect(summary.totalCovers).toBe(3);
  });

  it('returns zero for empty groups', () => {
    const summary = summarizeCovers([]);
    expect(summary.pendingBooks).toBe(0);
    expect(summary.totalCovers).toBe(0);
  });
});

describe('pickEligibleCoverIds', () => {
  it('picks one generated cover per selected book', () => {
    const groups = [
      makeBookCoverGroup({ bookId: 'b1', coverStatuses: ['generated', 'generated'] }),
      makeBookCoverGroup({ bookId: 'b2', coverStatuses: ['adopted'] }),
      makeBookCoverGroup({ bookId: 'b3', coverStatuses: ['generated'] }),
    ];
    const selected = new Set(['b1', 'b2', 'b3']);
    const result = pickEligibleCoverIds(groups, selected);
    expect(result).toEqual(['b1_cover_0', 'b3_cover_0']);
  });

  it('returns empty if no selection', () => {
    const groups = [makeBookCoverGroup({ bookId: 'b1' })];
    expect(pickEligibleCoverIds(groups, new Set())).toEqual([]);
  });
});

describe('booksWithGeneratedCovers', () => {
  it('returns only book IDs with generated covers', () => {
    const groups = [
      makeBookCoverGroup({ bookId: 'b1', coverStatuses: ['generated'] }),
      makeBookCoverGroup({ bookId: 'b2', coverStatuses: ['adopted'] }),
    ];
    expect(booksWithGeneratedCovers(groups)).toEqual(['b1']);
  });
});

describe('extractCoverCost', () => {
  it('extracts cost_jpy from meta', () => {
    expect(extractCoverCost({ cost_jpy: 38 })).toBe(38);
  });

  it('returns null for missing key', () => {
    expect(extractCoverCost({ model: 'x' })).toBeNull();
  });

  it('returns null for non-object', () => {
    expect(extractCoverCost(null)).toBeNull();
    expect(extractCoverCost('string')).toBeNull();
  });

  it('returns null for NaN cost', () => {
    expect(extractCoverCost({ cost_jpy: NaN })).toBeNull();
  });
});

describe('extractCoverModel', () => {
  it('extracts model from meta', () => {
    expect(extractCoverModel({ model: 'gpt-image-1' })).toBe('gpt-image-1');
  });

  it('returns null for missing key', () => {
    expect(extractCoverModel({ cost_jpy: 38 })).toBeNull();
  });

  it('returns null for non-string model', () => {
    expect(extractCoverModel({ model: 123 })).toBeNull();
  });
});

describe('formatGenre', () => {
  it('maps known genres to Japanese labels', () => {
    expect(formatGenre('practical')).toBe('実用書');
    expect(formatGenre('business')).toBe('ビジネス書');
    expect(formatGenre('self_help')).toBe('自己啓発');
  });

  it('returns raw value for unknown genre', () => {
    expect(formatGenre('nonexistent_genre_xyz')).toBe('nonexistent_genre_xyz');
  });

  it('returns null for null/undefined', () => {
    expect(formatGenre(null)).toBeNull();
    expect(formatGenre(undefined)).toBeNull();
  });
});

describe('formatDateTime', () => {
  it('formats ISO date to YYYY-MM-DD HH:mm', () => {
    const result = formatDateTime('2026-01-15T10:30:00.000Z');
    expect(result).toMatch(/2026-01-15/);
    expect(result).toMatch(/\d{2}:\d{2}/);
  });

  it('returns raw string for invalid date', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});
