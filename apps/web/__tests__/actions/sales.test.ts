/**
 * sales-core.ts unit tests (T-08-05, F-037).
 *
 * Checks:
 *  1. Single upsert inserts then updates same (book_id, year_month)
 *  2. CSV import of N rows → N upserts
 *  3. Malformed rows produce line-numbered errors without aborting valid rows
 *  4. Invalid input rejected (zod validation)
 *  5. Nonexistent book_id reported as a row error
 *  6. CSV header validation
 *  7. avg_stars / bsr optional handling
 */
import { describe, expect, it, vi } from 'vitest';
import { isFail, isOk } from '@a2p/contracts';

import {
  upsertSalesCore,
  importSalesCsvCore,
  parseCsv,
  type SalesDeps,
  type SalesRecordRepo,
  type BookExistsRepo,
  type AuditLogRepo,
} from '../../lib/sales-core';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeSalesRecordRepo(opts: {
  existingByKey?: Set<string>;
} = {}): {
  repo: SalesRecordRepo;
  upsertSpy: ReturnType<typeof vi.fn>;
  findUniqueSpy: ReturnType<typeof vi.fn>;
} {
  const existingKeys = opts.existingByKey ?? new Set<string>();

  const findUniqueSpy = vi.fn(async ({ where }: Parameters<SalesRecordRepo['findUnique']>[0]) => {
    const key = `${where.book_id_year_month.book_id}/${where.book_id_year_month.year_month}`;
    return existingKeys.has(key) ? { id: `rec_${key}` } : null;
  });

  const upsertSpy = vi.fn(async ({ where, create, update }: Parameters<SalesRecordRepo['upsert']>[0]) => {
    const key = `${where.book_id_year_month.book_id}/${where.book_id_year_month.year_month}`;
    existingKeys.add(key);
    return {
      id: `rec_${key}`,
      book_id: where.book_id_year_month.book_id,
      year_month: where.book_id_year_month.year_month,
      royalty_jpy: existingKeys.has(key) ? update.royalty_jpy : create.royalty_jpy,
      review_count: existingKeys.has(key) ? update.review_count : create.review_count,
      avg_stars: null,
      bsr: null,
      source: 'manual',
    };
  });

  return {
    repo: { findUnique: findUniqueSpy, upsert: upsertSpy },
    upsertSpy,
    findUniqueSpy,
  };
}

function makeBookRepo(existingIds: string[] = ['book_1', 'book_2']): {
  repo: BookExistsRepo;
  findUniqueSpy: ReturnType<typeof vi.fn>;
} {
  const idSet = new Set(existingIds);
  const findUniqueSpy = vi.fn(async ({ where }: Parameters<BookExistsRepo['findUnique']>[0]) =>
    idSet.has(where.id) ? { id: where.id } : null,
  );
  // asin/title 解決: 'ASIN-<id>' や 'TITLE-<id>' を該当 id にマップする簡易実装。
  const findFirstSpy = vi.fn(async ({ where }: { where: { asin?: string; title?: string } }) => {
    const v = where.asin ?? where.title ?? '';
    const id = v.replace(/^(ASIN|TITLE)-/, '');
    return idSet.has(id) ? { id } : null;
  });
  return { repo: { findUnique: findUniqueSpy, findFirst: findFirstSpy }, findUniqueSpy };
}

function makeAuditRepo(): {
  repo: AuditLogRepo;
  createSpy: ReturnType<typeof vi.fn>;
} {
  const createSpy = vi.fn(async () => ({}));
  return { repo: { create: createSpy }, createSpy };
}

function makeDeps(opts: {
  existingKeys?: Set<string>;
  bookIds?: string[];
} = {}): {
  deps: SalesDeps;
  salesRepo: ReturnType<typeof makeSalesRecordRepo>;
  bookRepo: ReturnType<typeof makeBookRepo>;
  auditRepo: ReturnType<typeof makeAuditRepo>;
} {
  const salesRepo = makeSalesRecordRepo({ existingByKey: opts.existingKeys });
  const bookRepo = makeBookRepo(opts.bookIds);
  const auditRepo = makeAuditRepo();

  return {
    deps: {
      salesRecordRepo: salesRepo.repo,
      bookRepo: bookRepo.repo,
      auditLogRepo: auditRepo.repo,
      session: { user: { id: 'u_1', username: 'operator' } },
    },
    salesRepo,
    bookRepo,
    auditRepo,
  };
}

// ---------------------------------------------------------------------------
// Test 1: single upsert inserts then updates same (book_id, year_month)
// ---------------------------------------------------------------------------

describe('upsertSalesCore — insert then update', () => {
  it('inserts a new record when the key does not exist', async () => {
    const { deps, salesRepo, auditRepo } = makeDeps();

    const result = await upsertSalesCore(
      {
        book_id: 'book_1',
        year_month: '2026-05',
        royalty_jpy: 1200,
        review_count: 3,
        avg_stars: 4.5,
        bsr: 5000,
      },
      deps,
    );

    expect(isOk(result)).toBe(true);
    expect(salesRepo.upsertSpy).toHaveBeenCalledTimes(1);

    const call = salesRepo.upsertSpy.mock.calls[0]?.[0];
    expect(call?.create.book_id).toBe('book_1');
    expect(call?.create.year_month).toBe('2026-05');
    expect(call?.create.royalty_jpy).toBe(1200);
    expect(call?.create.review_count).toBe(3);
    expect(call?.create.avg_stars).toBe(4.5);
    expect(call?.create.bsr).toBe(5000);
    expect(call?.create.source).toBe('manual');

    // Audit logged as insert
    expect(auditRepo.createSpy).toHaveBeenCalledTimes(1);
    const auditCall = auditRepo.createSpy.mock.calls[0]?.[0];
    expect(auditCall?.data.action).toBe('sales.insert');
  });

  it('updates existing record when the key already exists', async () => {
    const existingKeys = new Set<string>(['book_1/2026-05']);
    const { deps, salesRepo, auditRepo } = makeDeps({ existingKeys });

    const result = await upsertSalesCore(
      {
        book_id: 'book_1',
        year_month: '2026-05',
        royalty_jpy: 2000,
        review_count: 10,
      },
      deps,
    );

    expect(isOk(result)).toBe(true);

    const call = salesRepo.upsertSpy.mock.calls[0]?.[0];
    expect(call?.update.royalty_jpy).toBe(2000);
    expect(call?.update.review_count).toBe(10);

    // Audit logged as update
    const auditCall = auditRepo.createSpy.mock.calls[0]?.[0];
    expect(auditCall?.data.action).toBe('sales.update');
  });

  it('sets avg_stars and bsr to null in update when not provided', async () => {
    const existingKeys = new Set<string>(['book_1/2026-05']);
    const { deps, salesRepo } = makeDeps({ existingKeys });

    await upsertSalesCore(
      { book_id: 'book_1', year_month: '2026-05', royalty_jpy: 500, review_count: 0 },
      deps,
    );

    const call = salesRepo.upsertSpy.mock.calls[0]?.[0];
    expect(call?.update.avg_stars).toBeNull();
    expect(call?.update.bsr).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 2: CSV import of N rows → N upserts
// ---------------------------------------------------------------------------

describe('importSalesCsvCore — 100 rows', () => {
  it('imports 100 valid rows and returns inserted=100, updated=0, errors=[]', async () => {
    const { deps, salesRepo } = makeDeps({ bookIds: Array.from({ length: 100 }, (_, i) => `book_${i}`) });

    const lines = ['book_id,year_month,royalty_jpy,review_count,avg_stars,bsr'];
    for (let i = 0; i < 100; i++) {
      lines.push(`book_${i},2026-05,${1000 + i},${i},4.2,${5000 + i}`);
    }
    const csv = lines.join('\n');

    const result = await importSalesCsvCore({ csv }, deps);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.inserted).toBe(100);
      expect(result.data.updated).toBe(0);
      expect(result.data.errors).toHaveLength(0);
    }

    expect(salesRepo.upsertSpy).toHaveBeenCalledTimes(100);
  });

  it('先頭列 asin でも書籍を解決して取り込む', async () => {
    const { deps, salesRepo } = makeDeps({ bookIds: ['book_1', 'book_2'] });
    const csv = [
      'asin,year_month,royalty_jpy,review_count,avg_stars,bsr',
      'ASIN-book_1,2026-05,1500,5,4.0,3000',
      'ASIN-book_2,2026-05,900,2,,',
    ].join('\n');
    const result = await importSalesCsvCore({ csv }, deps);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.inserted).toBe(2);
      expect(result.data.errors).toHaveLength(0);
    }
    // book_id に解決されて upsert される
    expect(salesRepo.upsertSpy.mock.calls[0]?.[0].create.book_id).toBe('book_1');
  });

  it('先頭列 title で未知タイトルは book_not_found', async () => {
    const { deps } = makeDeps({ bookIds: ['book_1'] });
    const csv = [
      'title,year_month,royalty_jpy,review_count,avg_stars,bsr',
      'TITLE-unknown,2026-05,1500,5,,',
    ].join('\n');
    const result = await importSalesCsvCore({ csv }, deps);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.inserted).toBe(0);
      expect(result.data.errors).toHaveLength(1);
    }
  });

  it('不正な先頭列ヘッダ (facebook) は validation エラー', async () => {
    const { deps } = makeDeps();
    const csv = ['facebook,year_month,royalty_jpy,review_count,avg_stars,bsr', 'x,2026-05,1,0,,'].join('\n');
    const result = await importSalesCsvCore({ csv }, deps);
    expect(isOk(result)).toBe(false);
  });

  it('treats duplicate key rows as updates', async () => {
    const existingKeys = new Set<string>(['book_1/2026-05']);
    const { deps } = makeDeps({ existingKeys });

    const csv = [
      'book_id,year_month,royalty_jpy,review_count,avg_stars,bsr',
      'book_1,2026-05,1500,5,4.0,3000',
    ].join('\n');

    const result = await importSalesCsvCore({ csv }, deps);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.inserted).toBe(0);
      expect(result.data.updated).toBe(1);
      expect(result.data.errors).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: malformed rows produce line-numbered errors without aborting
// ---------------------------------------------------------------------------

describe('importSalesCsvCore — partial errors', () => {
  it('skips bad rows and reports line-numbered errors, continues valid rows', async () => {
    const { deps, salesRepo } = makeDeps();

    const csv = [
      'book_id,year_month,royalty_jpy,review_count,avg_stars,bsr',
      'book_1,2026-05,1000,2,4.0,5000',    // valid → line 2
      'book_1,INVALID,1000,2,,',             // bad year_month → line 3
      'book_1,2026-06,-100,0,,',             // negative royalty → line 4
      'book_1,2026-07,500,0,5.5,',           // avg_stars out of range → line 5
      'book_1,2026-08,500,0,4.0,',           // valid (bsr empty) → line 6
      ',2026-09,500,0,,',                    // empty book_id → line 7
      'book_1,2026-10,500,ABC,,',            // non-int review_count → line 8
    ].join('\n');

    const result = await importSalesCsvCore({ csv }, deps);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      // lines 2, 6 are valid → 2 inserts
      expect(result.data.inserted).toBe(2);
      expect(result.data.updated).toBe(0);
      // lines 3, 4, 5, 7, 8 → 5 errors
      expect(result.data.errors).toHaveLength(5);

      const errorLines = result.data.errors.map(e => e.row);
      expect(errorLines).toContain(3);  // invalid year_month
      expect(errorLines).toContain(4);  // negative royalty
      expect(errorLines).toContain(5);  // avg_stars > 5
      expect(errorLines).toContain(7);  // empty book_id
      expect(errorLines).toContain(8);  // non-int review_count
    }

    // Only 2 upserts called
    expect(salesRepo.upsertSpy).toHaveBeenCalledTimes(2);
  });

  it('reports CRLF-terminated CSV correctly', async () => {
    const { deps, salesRepo } = makeDeps();

    const csv = 'book_id,year_month,royalty_jpy,review_count,avg_stars,bsr\r\nbook_1,2026-05,1000,2,4.0,5000\r\n';

    const result = await importSalesCsvCore({ csv }, deps);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.inserted).toBe(1);
      expect(result.data.errors).toHaveLength(0);
    }
    expect(salesRepo.upsertSpy).toHaveBeenCalledTimes(1);
  });

  it('handles trailing newline without creating extra error row', async () => {
    const { deps } = makeDeps();

    const csv = 'book_id,year_month,royalty_jpy,review_count,avg_stars,bsr\nbook_1,2026-05,1000,2,,\n';

    const result = await importSalesCsvCore({ csv }, deps);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.errors).toHaveLength(0);
      expect(result.data.inserted).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: invalid input rejected
// ---------------------------------------------------------------------------

describe('upsertSalesCore — validation', () => {
  it('missing book_id fails with validation code', async () => {
    const { deps } = makeDeps();
    const result = await upsertSalesCore(
      { year_month: '2026-05', royalty_jpy: 100, review_count: 0 },
      deps,
    );
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('invalid year_month format fails', async () => {
    const { deps } = makeDeps();
    const result = await upsertSalesCore(
      { book_id: 'book_1', year_month: '2026/05', royalty_jpy: 100, review_count: 0 },
      deps,
    );
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('negative royalty_jpy fails', async () => {
    const { deps } = makeDeps();
    const result = await upsertSalesCore(
      { book_id: 'book_1', year_month: '2026-05', royalty_jpy: -1, review_count: 0 },
      deps,
    );
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('avg_stars > 5 fails', async () => {
    const { deps } = makeDeps();
    const result = await upsertSalesCore(
      { book_id: 'book_1', year_month: '2026-05', royalty_jpy: 100, review_count: 0, avg_stars: 5.1 },
      deps,
    );
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('null input fails with validation code', async () => {
    const { deps } = makeDeps();
    const result = await upsertSalesCore(null, deps);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });
});

describe('importSalesCsvCore — validation', () => {
  it('invalid header returns validation fail', async () => {
    const { deps } = makeDeps();
    const csv = 'wrong_header,year_month,royalty_jpy,review_count,avg_stars,bsr\nbook_1,2026-05,100,0,,';
    const result = await importSalesCsvCore({ csv }, deps);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('empty csv body (only header) returns no-data fail', async () => {
    const { deps } = makeDeps();
    const csv = 'book_id,year_month,royalty_jpy,review_count,avg_stars,bsr';
    const result = await importSalesCsvCore({ csv }, deps);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });

  it('completely empty csv fails', async () => {
    const { deps } = makeDeps();
    const result = await importSalesCsvCore({ csv: '   ' }, deps);
    // Either validation (empty csv schema) or no-data
    expect(isFail(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 5: nonexistent book_id reported as row error
// ---------------------------------------------------------------------------

describe('upsertSalesCore — book not found', () => {
  it('returns not_found when book does not exist', async () => {
    const { deps } = makeDeps({ bookIds: [] });
    const result = await upsertSalesCore(
      { book_id: 'nonexistent', year_month: '2026-05', royalty_jpy: 100, review_count: 0 },
      deps,
    );
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('not_found');
  });
});

describe('importSalesCsvCore — nonexistent book_id', () => {
  it('reports row error for nonexistent book_id without aborting other rows', async () => {
    const { deps, salesRepo } = makeDeps({ bookIds: ['book_1'] });

    const csv = [
      'book_id,year_month,royalty_jpy,review_count,avg_stars,bsr',
      'book_1,2026-05,1000,2,,',         // valid book
      'ghost_book,2026-05,500,0,,',      // nonexistent book
      'book_1,2026-06,800,1,,',          // valid book, different month
    ].join('\n');

    const result = await importSalesCsvCore({ csv }, deps);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.inserted).toBe(2);   // book_1/2026-05 + book_1/2026-06
      expect(result.data.updated).toBe(0);
      expect(result.data.errors).toHaveLength(1);
      expect(result.data.errors[0]?.row).toBe(3); // line 3 = second data row
      expect(result.data.errors[0]?.message).toBe('書籍が見つかりません（book_id / asin / title のいずれか）');
    }

    expect(salesRepo.upsertSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Test 6: parseCsv helper
// ---------------------------------------------------------------------------

describe('parseCsv', () => {
  it('parses simple CSV', () => {
    const result = parseCsv('a,b,c\n1,2,3');
    expect(result).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('handles CRLF line endings', () => {
    const result = parseCsv('a,b\r\n1,2\r\n');
    expect(result).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('handles quoted fields with commas', () => {
    const result = parseCsv('"hello, world",2\n');
    expect(result).toEqual([['hello, world', '2']]);
  });

  it('handles escaped double-quotes inside quoted fields', () => {
    const result = parseCsv('"say ""hi""",value\n');
    expect(result).toEqual([['say "hi"', 'value']]);
  });

  it('ignores trailing blank line', () => {
    const result = parseCsv('a,b\n1,2\n');
    expect(result).toHaveLength(2);
  });

  it('handles empty optional fields', () => {
    const result = parseCsv('a,,c');
    expect(result).toEqual([['a', '', 'c']]);
  });
});

// ---------------------------------------------------------------------------
// Test 7: avg_stars / bsr optional handling
// ---------------------------------------------------------------------------

describe('upsertSalesCore — optional fields', () => {
  it('upsert without avg_stars and bsr does not include them in create payload', async () => {
    const { deps, salesRepo } = makeDeps();

    await upsertSalesCore(
      { book_id: 'book_1', year_month: '2026-05', royalty_jpy: 500, review_count: 0 },
      deps,
    );

    const call = salesRepo.upsertSpy.mock.calls[0]?.[0];
    expect('avg_stars' in call?.create).toBe(false);
    expect('bsr' in call?.create).toBe(false);
  });

  it('upsert with avg_stars=0 and bsr=0 includes them in create payload', async () => {
    const { deps, salesRepo } = makeDeps();

    await upsertSalesCore(
      { book_id: 'book_1', year_month: '2026-05', royalty_jpy: 500, review_count: 0, avg_stars: 0, bsr: 0 },
      deps,
    );

    const call = salesRepo.upsertSpy.mock.calls[0]?.[0];
    expect(call?.create.avg_stars).toBe(0);
    expect(call?.create.bsr).toBe(0);
  });

  it('CSV rows with empty avg_stars and bsr are treated as omitted', async () => {
    const { deps, salesRepo } = makeDeps();

    const csv = 'book_id,year_month,royalty_jpy,review_count,avg_stars,bsr\nbook_1,2026-05,500,0,,';
    const result = await importSalesCsvCore({ csv }, deps);

    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.errors).toHaveLength(0);
    }

    const call = salesRepo.upsertSpy.mock.calls[0]?.[0];
    // avg_stars and bsr not in create when empty
    expect('avg_stars' in call?.create).toBe(false);
    expect('bsr' in call?.create).toBe(false);
  });
});
