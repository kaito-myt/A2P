/**
 * E2E AB Comparison Test Fixture (T-13-08, F-026)
 *
 * Seed helpers for creating test data:
 * - Book + TokenUsage + EvalResult + SalesRecord
 *
 * Used by:
 *   - tests/e2e/ab-comparison-runtime.spec.ts
 *   - tests/e2e/ab-comparison.spec.ts
 */

import { prisma, Prisma } from '@a2p/db';

const TEST_PREFIX = 'e2e-ab-comparison';

/**
 * Data context returned after seeding.
 */
export interface AbComparisonSeedContext {
  books: {
    id: string;
    title: string;
    created_at: Date;
    done_at: Date | null;
    prompt_version_id: string; // used for 'prompt' mode
    model: string; // used for 'model' mode
  }[];
  account_id: string;
  theme_id: string;
}

/**
 * Cleanup: delete all test rows created by this fixture.
 */
export async function cleanupAbComparisonSeed(): Promise<void> {
  const accounts = await prisma.account.findMany({
    where: { pen_name: { startsWith: TEST_PREFIX } },
    select: { id: true },
  });

  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return;

  const books = await prisma.book.findMany({
    where: { account_id: { in: accountIds } },
    select: { id: true },
  });
  const bookIds = books.map((b) => b.id);

  if (bookIds.length > 0) {
    // Cleanup in cascade order
    await prisma.salesRecord
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);

    await prisma.evalResult
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);

    await prisma.tokenUsage
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);

    await prisma.job
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);

    await prisma.bookLock
      .deleteMany({ where: { book_id: { in: bookIds } } })
      .catch(() => undefined);

    await prisma.book
      .deleteMany({ where: { id: { in: bookIds } } })
      .catch(() => undefined);
  }

  await prisma.themeCandidate
    .deleteMany({ where: { account_id: { in: accountIds } } })
    .catch(() => undefined);

  await prisma.account
    .deleteMany({ where: { id: { in: accountIds } } })
    .catch(() => undefined);
}

/**
 * Seed a test account and theme.
 */
async function seedAccountAndTheme(label: string): Promise<{ account_id: string; theme_id: string }> {
  const ts = Date.now();

  const account = await prisma.account.create({
    data: {
      pen_name: `${TEST_PREFIX}-${label}-${ts}`,
      genre_policy_json: {
        primary_genre: 'business',
        ratio: { business: 1 },
        focus_themes: ['ab_comparison_test'],
      } as unknown as Prisma.InputJsonValue,
      status: 'archived',
    },
    select: { id: true },
  });

  const theme = await prisma.themeCandidate.create({
    data: {
      account_id: account.id,
      theme_session_id: `${TEST_PREFIX}-${label}-session-${ts}`,
      genre: 'business',
      title: `AB Comparison Test Theme ${label}`,
      hook: 'ab comparison test',
      competitors_json: [] as unknown as Prisma.InputJsonValue,
      signals_json: { sources: ['test'] } as unknown as Prisma.InputJsonValue,
      status: 'accepted',
      decided_at: new Date(),
    },
    select: { id: true },
  });

  return {
    account_id: account.id,
    theme_id: theme.id,
  };
}

/**
 * Seed a single book with specified parameters.
 */
interface BookSeedParams {
  account_id: string;
  theme_id: string;
  title: string;
  created_at: Date;
  done_at?: Date | null;
  prompt_version_id?: string;
  model?: string;
  quality_score?: number;
  cost_jpy?: number;
  cached_input_tokens?: number;
  input_tokens?: number;
  royalty_jpy?: number;
}

async function seedBook(params: BookSeedParams): Promise<{
  id: string;
  title: string;
  created_at: Date;
  done_at: Date | null;
  prompt_version_id: string;
  model: string;
}> {
  const book = await prisma.book.create({
    data: {
      account_id: params.account_id,
      theme_id: params.theme_id,
      title: params.title,
      status: params.done_at ? 'done' : 'writing',
      created_at: params.created_at,
      done_at: params.done_at ?? null,
      cost_status: 'normal',
      prompt_version_ids_json: {
        writer: params.prompt_version_id ?? 'pv-baseline-v1',
        editor: 'pv-editor-v1',
      } as unknown as Prisma.InputJsonValue,
      model_assignment_snapshot: {
        writer: { model: params.model ?? 'claude-3-5-sonnet-20241022' },
        editor: { model: 'claude-3-5-sonnet-20241022' },
      } as unknown as Prisma.InputJsonValue,
    },
    select: { id: true, created_at: true, done_at: true },
  });

  // Seed TokenUsage
  if ((params.cost_jpy ?? 0) > 0) {
    await prisma.tokenUsage.create({
      data: {
        book_id: book.id,
        provider: 'anthropic',
        model: params.model ?? 'claude-3-5-sonnet-20241022',
        role: 'writer',
        input_tokens: params.input_tokens ?? 5000,
        output_tokens: 10000,
        image_count: 0,
        cached_input_tokens: params.cached_input_tokens ?? 0,
        unit_price_snapshot: {
          provider: 'anthropic',
          model: params.model ?? 'claude-3-5-sonnet-20241022',
          input_price_per_1k: 0.003,
          output_price_per_1k: 0.0015,
        } as unknown as Prisma.InputJsonValue,
        cost_jpy: params.cost_jpy ?? 100,
        created_at: book.created_at,
      },
    });
  }

  // Seed EvalResult
  if ((params.quality_score ?? 0) > 0) {
    await prisma.evalResult.create({
      data: {
        book_id: book.id,
        prompt_version_ids_json: {
          writer: params.prompt_version_id ?? 'pv-baseline-v1',
        } as unknown as Prisma.InputJsonValue,
        score_total: Math.round(params.quality_score ?? 85),
        score_breakdown_json: {
          benefit_clarity: Math.round(params.quality_score ?? 85),
          logical_consistency: Math.round(params.quality_score ?? 85),
          style_consistency: Math.round(params.quality_score ?? 85),
          japanese_naturalness: Math.round(params.quality_score ?? 85),
          title_alignment: Math.round(params.quality_score ?? 85),
          genre_fit: Math.round(params.quality_score ?? 85),
        } as unknown as Prisma.InputJsonValue,
        judge_comments_json: { notes: 'test eval' } as unknown as Prisma.InputJsonValue,
        triggered_by: 'auto',
      },
    });
  }

  // Seed SalesRecord
  if ((params.royalty_jpy ?? 0) > 0) {
    await prisma.salesRecord.create({
      data: {
        book_id: book.id,
        year_month: '2026-01',
        royalty_jpy: Math.round(params.royalty_jpy ?? 1000),
        source: 'manual',
      },
    });
  }

  return {
    id: book.id,
    title: params.title,
    created_at: book.created_at,
    done_at: book.done_at,
    prompt_version_id: params.prompt_version_id ?? 'pv-baseline-v1',
    model: params.model ?? 'claude-3-5-sonnet-20241022',
  };
}

/**
 * Fixed UTC date ranges for period mode testing.
 * Using past calendar months avoids timezone ambiguity with toISOString() slicing.
 *
 * Period A: April 2026 UTC  (dateFromA=2026-04-01, dateToA=2026-05-01)
 * Period B: May 2026 UTC    (dateFromB=2026-05-01, dateToB=2026-06-01)
 */
export const PERIOD_MODE_DATE_PARAMS =
  'dateFromA=2026-04-01&dateToA=2026-05-01&dateFromB=2026-05-01&dateToB=2026-06-01';

/**
 * Seed books for "period" mode testing:
 * - Group A (periodA): 3 books in April 2026 UTC
 * - Group B (periodB): 8 books in May 2026 UTC
 *
 * Uses fixed past UTC dates so URL params and DB queries align deterministically
 * regardless of the test runner's local timezone.
 *
 * Returns book list with metadata for assertions.
 */
export async function seedBooksForPeriodMode(): Promise<AbComparisonSeedContext> {
  const { account_id, theme_id } = await seedAccountAndTheme('period-mode');

  // Fixed UTC boundaries — must match PERIOD_MODE_DATE_PARAMS
  const periodAStart = new Date('2026-04-01T00:00:00.000Z');
  const periodAEnd = new Date('2026-05-01T00:00:00.000Z');
  const periodBStart = new Date('2026-05-01T00:00:00.000Z');
  const periodBEnd = new Date('2026-06-01T00:00:00.000Z');

  const books: AbComparisonSeedContext['books'] = [];

  // Period A: 3 books (insufficient for minSample=5)
  for (let i = 0; i < 3; i++) {
    const createdAt = new Date(
      periodAStart.getTime() + (i * (periodAEnd.getTime() - periodAStart.getTime())) / 3,
    );
    const book = await seedBook({
      account_id,
      theme_id,
      title: `Period A Book ${i + 1}`,
      created_at: createdAt,
      done_at: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
      quality_score: 80 + Math.random() * 10,
      cost_jpy: 100 + Math.random() * 50,
      cached_input_tokens: Math.floor(Math.random() * 1000),
      input_tokens: 5000 + Math.random() * 1000,
      royalty_jpy: 500 + Math.random() * 500,
    });
    books.push(book);
  }

  // Period B: 8 books (sufficient for minSample=5)
  for (let i = 0; i < 8; i++) {
    const createdAt = new Date(
      periodBStart.getTime() + (i * (periodBEnd.getTime() - periodBStart.getTime())) / 8,
    );
    const book = await seedBook({
      account_id,
      theme_id,
      title: `Period B Book ${i + 1}`,
      created_at: createdAt,
      done_at: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
      quality_score: 82 + Math.random() * 10,
      cost_jpy: 95 + Math.random() * 50,
      cached_input_tokens: Math.floor(Math.random() * 2000),
      input_tokens: 5000 + Math.random() * 1000,
      royalty_jpy: 550 + Math.random() * 500,
    });
    books.push(book);
  }

  return { books, account_id, theme_id };
}

/**
 * Seed books for "prompt" mode testing:
 * - Group A (baseline): 6 books with pv-baseline-v1
 * - Group B (candidate): 7 books with pv-candidate-v1
 *
 * Returns book list with metadata for assertions.
 */
export async function seedBooksForPromptMode(): Promise<AbComparisonSeedContext> {
  const { account_id, theme_id } = await seedAccountAndTheme('prompt-mode');
  const books: AbComparisonSeedContext['books'] = [];

  const now = new Date();

  // Baseline: 6 books with pv-baseline-v1
  for (let i = 0; i < 6; i++) {
    const createdAt = new Date(now.getTime() - (6 - i) * 24 * 60 * 60 * 1000);
    const book = await seedBook({
      account_id,
      theme_id,
      title: `Prompt Baseline Book ${i + 1}`,
      created_at: createdAt,
      done_at: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
      prompt_version_id: 'pv-baseline-v1',
      model: 'claude-3-5-sonnet-20241022',
      quality_score: 78 + Math.random() * 10,
      cost_jpy: 120 + Math.random() * 60,
      cached_input_tokens: Math.floor(Math.random() * 500),
      input_tokens: 5000 + Math.random() * 1000,
      royalty_jpy: 400 + Math.random() * 400,
    });
    books.push(book);
  }

  // Candidate: 7 books with pv-candidate-v1
  for (let i = 0; i < 7; i++) {
    const createdAt = new Date(now.getTime() - (7 - i) * 24 * 60 * 60 * 1000);
    const book = await seedBook({
      account_id,
      theme_id,
      title: `Prompt Candidate Book ${i + 1}`,
      created_at: createdAt,
      done_at: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
      prompt_version_id: 'pv-candidate-v1',
      model: 'claude-3-5-sonnet-20241022',
      quality_score: 82 + Math.random() * 10,
      cost_jpy: 115 + Math.random() * 60,
      cached_input_tokens: Math.floor(Math.random() * 1500),
      input_tokens: 5000 + Math.random() * 1000,
      royalty_jpy: 450 + Math.random() * 400,
    });
    books.push(book);
  }

  return { books, account_id, theme_id };
}

/**
 * Seed books for "model" mode testing:
 * - Group A (baseline model): 5 books with claude-3-5-sonnet
 * - Group B (candidate model): 6 books with gpt-4o
 *
 * Returns book list with metadata for assertions.
 */
export async function seedBooksForModelMode(): Promise<AbComparisonSeedContext> {
  const { account_id, theme_id } = await seedAccountAndTheme('model-mode');
  const books: AbComparisonSeedContext['books'] = [];

  const now = new Date();

  // Baseline: 5 books with claude-3-5-sonnet-20241022
  for (let i = 0; i < 5; i++) {
    const createdAt = new Date(now.getTime() - (5 - i) * 24 * 60 * 60 * 1000);
    const book = await seedBook({
      account_id,
      theme_id,
      title: `Model Sonnet Book ${i + 1}`,
      created_at: createdAt,
      done_at: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
      prompt_version_id: 'pv-v1',
      model: 'claude-3-5-sonnet-20241022',
      quality_score: 80 + Math.random() * 10,
      cost_jpy: 130 + Math.random() * 70,
      cached_input_tokens: Math.floor(Math.random() * 800),
      input_tokens: 5000 + Math.random() * 1000,
      royalty_jpy: 380 + Math.random() * 400,
    });
    books.push(book);
  }

  // Candidate: 6 books with gpt-4o
  for (let i = 0; i < 6; i++) {
    const createdAt = new Date(now.getTime() - (6 - i) * 24 * 60 * 60 * 1000);
    const book = await seedBook({
      account_id,
      theme_id,
      title: `Model GPT-4o Book ${i + 1}`,
      created_at: createdAt,
      done_at: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
      prompt_version_id: 'pv-v1',
      model: 'gpt-4o-2024-11-20',
      quality_score: 84 + Math.random() * 10,
      cost_jpy: 100 + Math.random() * 50,
      cached_input_tokens: Math.floor(Math.random() * 1200),
      input_tokens: 5000 + Math.random() * 1000,
      royalty_jpy: 420 + Math.random() * 400,
    });
    books.push(book);
  }

  return { books, account_id, theme_id };
}
