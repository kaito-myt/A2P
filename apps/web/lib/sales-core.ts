/**
 * upsertSales / importSalesCsv SA core logic (T-08-05, F-037).
 *
 * `app/actions/sales.ts` (SA wrapper) から呼ばれる業務ロジック。
 * 依存は DI で受け取り Vitest でユニットテスト可能にする。
 *
 * 設計判断:
 *  - upsert は (book_id, year_month) のユニーク制約を利用し、
 *    挿入 or 上書きを 1 クエリで完結させる。
 *  - importSalesCsv は行ごとに upsertSalesCore を呼ばず、
 *    直接 repo を呼ぶことで DI 境界を明確に保つ。
 *  - 不正行は skip し { inserted, updated, errors } に集約する。
 *  - CSV は軽量な手書きパーサで処理（quoted field / CRLF / 末尾改行 対応）。
 *  - audit_log: CSV import バッチは 1 回、単件 upsert も 1 回記録。
 *    チェックボックストグルと違い「明示的なデータ編集」なので記録対象
 *    (docs/05 §13 申し送り 4)。
 *
 * 仕様根拠: docs/05 §4.3.13 / docs/02 F-037 / SP-08 T-08-05
 */
import { z } from 'zod';
import { Prisma } from '@a2p/db';

import {
  isA2PError,
  fail,
  ok,
  type ActionResult,
} from '@a2p/contracts';

import type { AuthenticatedSession } from './auth-helpers';
import { messages } from './messages';

// ---------------------------------------------------------------------------
// zod schemas (docs/05 §4.3.13)
// ---------------------------------------------------------------------------

export const UpsertSalesInputSchema = z.object({
  book_id: z.string().min(1),
  year_month: z.string().regex(/^\d{4}-\d{2}$/, 'YYYY-MM 形式で入力してください'),
  royalty_jpy: z.number().int().min(0),
  review_count: z.number().int().min(0),
  avg_stars: z.number().min(0).max(5).optional(),
  bsr: z.number().int().min(0).optional(),
});

export type UpsertSalesInput = z.infer<typeof UpsertSalesInputSchema>;

export const ImportSalesCsvInputSchema = z.object({
  csv: z.string().min(1),
});

export type ImportSalesCsvInput = z.infer<typeof ImportSalesCsvInputSchema>;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ImportSalesCsvResult {
  inserted: number;
  updated: number;
  errors: Array<{ row: number; message: string }>;
}

// ---------------------------------------------------------------------------
// DI boundary
// ---------------------------------------------------------------------------

export interface SalesRecordRow {
  id: string;
  book_id: string;
  year_month: string;
  royalty_jpy: number;
  review_count: number;
  avg_stars: unknown;  // Decimal? from Prisma
  bsr: number | null;
  source: string;
}

export interface SalesRecordRepo {
  findUnique(args: {
    where: { book_id_year_month: { book_id: string; year_month: string } };
    select: { id: true };
  }): Promise<{ id: string } | null>;

  upsert(args: {
    where: { book_id_year_month: { book_id: string; year_month: string } };
    create: {
      book_id: string;
      year_month: string;
      royalty_jpy: number;
      review_count: number;
      avg_stars?: number;
      bsr?: number;
      source: string;
    };
    update: {
      royalty_jpy: number;
      review_count: number;
      avg_stars?: number | null;
      bsr?: number | null;
      source: string;
    };
  }): Promise<SalesRecordRow>;
}

export interface BookExistsRepo {
  findUnique(args: {
    where: { id: string };
    select: { id: true };
  }): Promise<{ id: string } | null>;
  /** ASIN / タイトルで書籍を解決する (CSV の識別子列が asin/title のとき使用)。 */
  findFirst?(args: {
    where: { asin?: string; title?: string };
    select: { id: true };
  }): Promise<{ id: string } | null>;
}

export interface AuditLogRepo {
  create(args: { data: Prisma.AuditLogUncheckedCreateInput }): Promise<unknown>;
}

export interface SalesDeps {
  salesRecordRepo: SalesRecordRepo;
  bookRepo: BookExistsRepo;
  auditLogRepo: AuditLogRepo;
  session: AuthenticatedSession;
}

// ---------------------------------------------------------------------------
// upsertSalesCore
// ---------------------------------------------------------------------------

export async function upsertSalesCore(
  raw: unknown,
  deps: SalesDeps,
): Promise<ActionResult<void>> {
  const parsed = UpsertSalesInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.sales.errors.validation, parsed.error.flatten());
  }

  const input = parsed.data;

  try {
    const book = await deps.bookRepo.findUnique({
      where: { id: input.book_id },
      select: { id: true },
    });
    if (!book) {
      return fail('not_found', messages.sales.errors.bookNotFound);
    }

    const existing = await deps.salesRecordRepo.findUnique({
      where: { book_id_year_month: { book_id: input.book_id, year_month: input.year_month } },
      select: { id: true },
    });
    const isInsert = existing === null;

    await deps.salesRecordRepo.upsert({
      where: { book_id_year_month: { book_id: input.book_id, year_month: input.year_month } },
      create: {
        book_id: input.book_id,
        year_month: input.year_month,
        royalty_jpy: input.royalty_jpy,
        review_count: input.review_count,
        ...(input.avg_stars !== undefined ? { avg_stars: input.avg_stars } : {}),
        ...(input.bsr !== undefined ? { bsr: input.bsr } : {}),
        source: 'manual',
      },
      update: {
        royalty_jpy: input.royalty_jpy,
        review_count: input.review_count,
        avg_stars: input.avg_stars ?? null,
        bsr: input.bsr ?? null,
        source: 'manual',
      },
    });

    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: isInsert ? 'sales.insert' : 'sales.update',
        target_kind: 'sales_record',
        target_id: `${input.book_id}/${input.year_month}`,
        before_json: Prisma.JsonNull,
        after_json: {
          book_id: input.book_id,
          year_month: input.year_month,
          royalty_jpy: input.royalty_jpy,
          review_count: input.review_count,
          avg_stars: input.avg_stars ?? null,
          bsr: input.bsr ?? null,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    return ok(undefined as void);
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.sales.errors.unknown);
  }
}

// ---------------------------------------------------------------------------
// importSalesCsvCore
// ---------------------------------------------------------------------------

export async function importSalesCsvCore(
  raw: unknown,
  deps: SalesDeps,
): Promise<ActionResult<ImportSalesCsvResult>> {
  const parsed = ImportSalesCsvInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('validation', messages.sales.errors.validation, parsed.error.flatten());
  }

  const { csv } = parsed.data;

  try {
    const csvRows = parseCsv(csv);
    if (csvRows.length === 0) {
      return fail('validation', messages.sales.errors.csvNoData);
    }

    // Validate header — 先頭列は book_id / asin / title のいずれか、残りは固定。
    const REST_HEADERS = ['year_month', 'royalty_jpy', 'review_count', 'avg_stars', 'bsr'];
    const ID_COLUMNS = ['book_id', 'asin', 'title'] as const;
    const header = csvRows[0];
    const idKind = header?.[0] as (typeof ID_COLUMNS)[number] | undefined;
    if (
      !header ||
      !idKind ||
      !ID_COLUMNS.includes(idKind) ||
      !arraysEqual(header.slice(1), REST_HEADERS)
    ) {
      return fail('validation', messages.sales.errors.csvInvalidHeader);
    }

    const dataRows = csvRows.slice(1);
    if (dataRows.length === 0) {
      return fail('validation', messages.sales.errors.csvNoData);
    }

    let inserted = 0;
    let updated = 0;
    const errors: Array<{ row: number; message: string }> = [];

    for (let i = 0; i < dataRows.length; i++) {
      // line number = header(1) + data index(1-based)
      const lineNum = i + 2;
      const row = dataRows[i];
      if (!row) continue;

      const [rawId, rawYearMonth, rawRoyalty, rawReviewCount, rawAvgStars, rawBsr] = row;

      // 識別子 (book_id / asin / title)
      const idValue = (rawId ?? '').trim();
      if (!idValue) {
        errors.push({ row: lineNum, message: messages.sales.errors.csvEmptyBookId });
        continue;
      }

      // year_month
      const year_month = (rawYearMonth ?? '').trim();
      if (!/^\d{4}-\d{2}$/.test(year_month)) {
        errors.push({ row: lineNum, message: messages.sales.errors.csvInvalidYearMonth });
        continue;
      }

      // royalty_jpy
      const royalty_jpy = parseIntField(rawRoyalty ?? '');
      if (royalty_jpy === null || royalty_jpy < 0) {
        errors.push({ row: lineNum, message: messages.sales.errors.csvInvalidRoyalty });
        continue;
      }

      // review_count
      const review_count = parseIntField(rawReviewCount ?? '');
      if (review_count === null || review_count < 0) {
        errors.push({ row: lineNum, message: messages.sales.errors.csvInvalidReviewCount });
        continue;
      }

      // avg_stars (optional, empty string = omit)
      let avg_stars: number | undefined;
      const rawAvgStarsTrimmed = (rawAvgStars ?? '').trim();
      if (rawAvgStarsTrimmed !== '') {
        const parsed = parseFloatField(rawAvgStarsTrimmed);
        if (parsed === null || parsed < 0 || parsed > 5) {
          errors.push({ row: lineNum, message: messages.sales.errors.csvInvalidAvgStars });
          continue;
        }
        avg_stars = parsed;
      }

      // bsr (optional, empty string = omit)
      let bsr: number | undefined;
      const rawBsrTrimmed = (rawBsr ?? '').trim();
      if (rawBsrTrimmed !== '') {
        const parsedBsr = parseIntField(rawBsrTrimmed);
        if (parsedBsr === null || parsedBsr < 0) {
          errors.push({ row: lineNum, message: messages.sales.errors.csvInvalidBsr });
          continue;
        }
        bsr = parsedBsr;
      }

      // 識別子から書籍を解決 (book_id は id 一致、asin/title は findFirst)
      let book: { id: string } | null;
      if (idKind === 'book_id') {
        book = await deps.bookRepo.findUnique({ where: { id: idValue }, select: { id: true } });
      } else if (deps.bookRepo.findFirst) {
        book = await deps.bookRepo.findFirst({
          where: idKind === 'asin' ? { asin: idValue } : { title: idValue },
          select: { id: true },
        });
      } else {
        book = null;
      }
      if (!book) {
        errors.push({ row: lineNum, message: messages.sales.errors.csvBookNotFound });
        continue;
      }
      const book_id = book.id;

      // check insert vs update
      const existing = await deps.salesRecordRepo.findUnique({
        where: { book_id_year_month: { book_id, year_month } },
        select: { id: true },
      });
      const isInsert = existing === null;

      await deps.salesRecordRepo.upsert({
        where: { book_id_year_month: { book_id, year_month } },
        create: {
          book_id,
          year_month,
          royalty_jpy,
          review_count,
          ...(avg_stars !== undefined ? { avg_stars } : {}),
          ...(bsr !== undefined ? { bsr } : {}),
          source: 'manual',
        },
        update: {
          royalty_jpy,
          review_count,
          avg_stars: avg_stars ?? null,
          bsr: bsr ?? null,
          source: 'manual',
        },
      });

      if (isInsert) {
        inserted++;
      } else {
        updated++;
      }
    }

    // Single audit log entry for the entire import batch
    await deps.auditLogRepo.create({
      data: {
        actor_id: deps.session.user.id,
        action: 'sales.csv_import',
        target_kind: 'sales_record',
        target_id: 'batch',
        before_json: Prisma.JsonNull,
        after_json: {
          inserted,
          updated,
          error_count: errors.length,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    return ok({ inserted, updated, errors });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.sales.errors.unknown);
  }
}

// ---------------------------------------------------------------------------
// CSV parser — handles quoted fields, CRLF, trailing newline
// ---------------------------------------------------------------------------

/**
 * RFC 4180 準拠の軽量 CSV パーサ。
 * - ダブルクオートで囲まれたフィールド内のカンマ・改行・`""` エスケープに対応。
 * - CRLF / LF 両対応。
 * - 末尾の空行は除去。
 */
export function parseCsv(text: string): string[][] {
  // Normalize CRLF to LF
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < normalized.length) {
    const ch = normalized[i];

    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          // escaped double-quote
          field += '"';
          i += 2;
        } else {
          // closing quote
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        row.push(field);
        field = '';
        i++;
      } else if (ch === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }

  // Push last field and row
  row.push(field);
  if (row.some(f => f !== '')) {
    rows.push(row);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v.trim() === b[i]);
}

function parseIntField(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === '') return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  return parseInt(trimmed, 10);
}

function parseFloatField(s: string): number | null {
  const trimmed = s.trim();
  if (trimmed === '') return null;
  const n = parseFloat(trimmed);
  if (isNaN(n)) return null;
  return n;
}
