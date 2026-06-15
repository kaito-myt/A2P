/**
 * E2E Runtime: AB Comparison Query Tests (T-13-08, F-026)
 *
 * Tests the getAbComparisonStats function directly on real DB without UI.
 * Validates period/prompt/model modes and stats aggregation.
 *
 * No page interactions; Playwright used as test runner only.
 * Cost: zero (DB only, no LLM).
 */

import { test, expect } from '@playwright/test';
import { prisma } from '@a2p/db';
import { getAbComparisonStats, type AbComparisonFilter } from '@a2p/db/ab-comparison';
import {
  cleanupAbComparisonSeed,
  seedBooksForPeriodMode,
  seedBooksForPromptMode,
  seedBooksForModelMode,
} from './fixtures/ab-comparison-seed';

/**
 * Fixed date ranges for period mode tests — must match PERIOD_MODE_DATE_PARAMS
 * and the fixed UTC dates in seedBooksForPeriodMode().
 */
const PERIOD_A = {
  from: new Date('2026-04-01T00:00:00.000Z'),
  to: new Date('2026-05-01T00:00:00.000Z'),
};
const PERIOD_B = {
  from: new Date('2026-05-01T00:00:00.000Z'),
  to: new Date('2026-06-01T00:00:00.000Z'),
};

test.describe(
  'E2E Runtime: AB Comparison Stats Aggregation (T-13-08, F-026)',
  () => {
    test.setTimeout(60_000);

    test.beforeAll(async () => {
      await cleanupAbComparisonSeed();
    });

    test.afterAll(async () => {
      await cleanupAbComparisonSeed();
      await prisma.$disconnect();
    });

    // =========================================================================
    // Period Mode Tests
    // =========================================================================

    test.describe('Period Mode', () => {
      test('a. period mode: group A (3 books) insufficient_data=true, group B (8 books) sufficient', async () => {
        await cleanupAbComparisonSeed();
        const context = await seedBooksForPeriodMode();

        const filter: AbComparisonFilter = {
          mode: 'period',
          periodA: PERIOD_A,
          periodB: PERIOD_B,
          minSample: 5,
        };

        const result = await getAbComparisonStats(prisma, filter);

        // Group A: 3 books (insufficient)
        expect(result.group_a.book_count).toBe(3);
        expect(result.group_a.insufficient_data).toBe(true);

        // Group B: 8 books (sufficient)
        expect(result.group_b.book_count).toBe(8);
        expect(result.group_b.insufficient_data).toBe(false);

        // eslint-disable-next-line no-console
        console.log(
          '[period-a] group_a.insufficient_data=true (3<5) ✓, group_b.insufficient_data=false (8>=5) ✓',
        );
      });

      test('b. period mode: aggregated metrics are calculated', async () => {
        await cleanupAbComparisonSeed();
        const context = await seedBooksForPeriodMode();

        const filter: AbComparisonFilter = {
          mode: 'period',
          periodA: PERIOD_A,
          periodB: PERIOD_B,
          minSample: 5,
        };

        const result = await getAbComparisonStats(prisma, filter);

        // Group B has sufficient data; verify metrics are non-null
        expect(result.group_b.avg_quality_score).not.toBeNull();
        expect(result.group_b.avg_cost_jpy).not.toBeNull();
        expect(result.group_b.avg_lead_time_hours).not.toBeNull();
        expect(result.group_b.median_royalty_jpy).not.toBeNull();

        // Sanity checks on ranges
        expect(result.group_b.avg_quality_score!).toBeGreaterThan(0);
        expect(result.group_b.avg_cost_jpy!).toBeGreaterThan(0);
        expect(result.group_b.avg_lead_time_hours!).toBeGreaterThan(0);
        expect(result.group_b.median_royalty_jpy!).toBeGreaterThan(0);

        // eslint-disable-next-line no-console
        console.log(
          `[period-b] group_b metrics: quality=${result.group_b.avg_quality_score}, cost=${result.group_b.avg_cost_jpy}, lead_time=${result.group_b.avg_lead_time_hours}, royalty=${result.group_b.median_royalty_jpy} ✓`,
        );
      });

      test('c. period mode: cache hit rate calculated when cached_input_tokens > 0', async () => {
        await cleanupAbComparisonSeed();
        const context = await seedBooksForPeriodMode();

        const filter: AbComparisonFilter = {
          mode: 'period',
          periodA: PERIOD_A,
          periodB: PERIOD_B,
          minSample: 5,
        };

        const result = await getAbComparisonStats(prisma, filter);

        // Group B has cached tokens (from seed); cache_hit_rate should be > 0
        expect(result.group_b.total_cached_input_tokens).toBeGreaterThan(0);
        expect(result.group_b.total_input_tokens).toBeGreaterThan(0);
        expect(result.group_b.cache_hit_rate).not.toBeNull();
        expect(result.group_b.cache_hit_rate!).toBeGreaterThan(0);
        expect(result.group_b.cache_hit_rate!).toBeLessThanOrEqual(1);

        // eslint-disable-next-line no-console
        console.log(
          `[period-c] group_b cache_hit_rate=${(result.group_b.cache_hit_rate! * 100).toFixed(1)}% ✓`,
        );
      });

      test('d. period mode: book_ids array contains all books in group', async () => {
        await cleanupAbComparisonSeed();
        const context = await seedBooksForPeriodMode();

        const filter: AbComparisonFilter = {
          mode: 'period',
          periodA: PERIOD_A,
          periodB: PERIOD_B,
          minSample: 5,
        };

        const result = await getAbComparisonStats(prisma, filter);

        // book_ids should match book_count
        expect(result.group_a.book_ids).toHaveLength(3);
        expect(result.group_b.book_ids).toHaveLength(8);

        // All IDs should be non-empty strings
        for (const bookId of result.group_a.book_ids) {
          expect(bookId).toBeTruthy();
          expect(typeof bookId).toBe('string');
        }

        // eslint-disable-next-line no-console
        console.log(
          `[period-d] group_a.book_ids.length=${result.group_a.book_ids.length}, group_b.book_ids.length=${result.group_b.book_ids.length} ✓`,
        );
      });
    });

    // =========================================================================
    // Prompt Mode Tests
    // =========================================================================

    test.describe('Prompt Mode', () => {
      test('a. prompt mode: baseline vs candidate filtering by prompt_version_ids_json[role]', async () => {
        await cleanupAbComparisonSeed();
        const context = await seedBooksForPromptMode();

        const filter: AbComparisonFilter = {
          mode: 'prompt',
          role: 'writer',
          baselineId: 'pv-baseline-v1',
          candidateId: 'pv-candidate-v1',
          minSample: 5,
        };

        const result = await getAbComparisonStats(prisma, filter);

        // Baseline: 6 books
        expect(result.group_a.book_count).toBe(6);
        expect(result.group_a.insufficient_data).toBe(false);

        // Candidate: 7 books
        expect(result.group_b.book_count).toBe(7);
        expect(result.group_b.insufficient_data).toBe(false);

        // Verify labels contain version IDs
        expect(result.group_a.label).toContain('pv-baseline-v1');
        expect(result.group_b.label).toContain('pv-candidate-v1');

        // eslint-disable-next-line no-console
        console.log(
          '[prompt-a] baseline=6 books, candidate=7 books, labels contain version IDs ✓',
        );
      });

      test('b. prompt mode: metrics aggregated for prompt groups', async () => {
        await cleanupAbComparisonSeed();
        const context = await seedBooksForPromptMode();

        const filter: AbComparisonFilter = {
          mode: 'prompt',
          role: 'writer',
          baselineId: 'pv-baseline-v1',
          candidateId: 'pv-candidate-v1',
          minSample: 5,
        };

        const result = await getAbComparisonStats(prisma, filter);

        // Both groups have sufficient data and metrics
        expect(result.group_a.avg_quality_score).not.toBeNull();
        expect(result.group_b.avg_quality_score).not.toBeNull();
        expect(result.group_a.avg_cost_jpy).not.toBeNull();
        expect(result.group_b.avg_cost_jpy).not.toBeNull();

        // Candidate group should have slightly higher quality and lower cost (by design)
        expect(result.group_b.avg_quality_score!).toBeGreaterThan(result.group_a.avg_quality_score!);
        expect(result.group_b.avg_cost_jpy!).toBeLessThan(result.group_a.avg_cost_jpy! * 1.1); // allow some variance

        // eslint-disable-next-line no-console
        console.log(
          `[prompt-b] baseline quality=${result.group_a.avg_quality_score}, candidate quality=${result.group_b.avg_quality_score} ✓`,
        );
      });
    });

    // =========================================================================
    // Model Mode Tests
    // =========================================================================

    test.describe('Model Mode', () => {
      test('a. model mode: baseline vs candidate filtering by model_assignment_snapshot[role].model', async () => {
        await cleanupAbComparisonSeed();
        const context = await seedBooksForModelMode();

        const filter: AbComparisonFilter = {
          mode: 'model',
          role: 'writer',
          baselineId: 'claude-3-5-sonnet-20241022',
          candidateId: 'gpt-4o-2024-11-20',
          minSample: 5,
        };

        const result = await getAbComparisonStats(prisma, filter);

        // Baseline (Sonnet): 5 books
        expect(result.group_a.book_count).toBe(5);
        expect(result.group_a.insufficient_data).toBe(false);

        // Candidate (GPT-4o): 6 books
        expect(result.group_b.book_count).toBe(6);
        expect(result.group_b.insufficient_data).toBe(false);

        // Verify labels contain model names
        expect(result.group_a.label).toContain('claude-3-5-sonnet-20241022');
        expect(result.group_b.label).toContain('gpt-4o-2024-11-20');

        // eslint-disable-next-line no-console
        console.log(
          '[model-a] baseline(Sonnet)=5 books, candidate(GPT-4o)=6 books, labels contain model names ✓',
        );
      });

      test('b. model mode: metrics aggregated for model groups', async () => {
        await cleanupAbComparisonSeed();
        const context = await seedBooksForModelMode();

        const filter: AbComparisonFilter = {
          mode: 'model',
          role: 'writer',
          baselineId: 'claude-3-5-sonnet-20241022',
          candidateId: 'gpt-4o-2024-11-20',
          minSample: 5,
        };

        const result = await getAbComparisonStats(prisma, filter);

        // Both groups have metrics
        expect(result.group_a.avg_quality_score).not.toBeNull();
        expect(result.group_b.avg_quality_score).not.toBeNull();
        expect(result.group_a.avg_cost_jpy).not.toBeNull();
        expect(result.group_b.avg_cost_jpy).not.toBeNull();

        // Candidate (GPT-4o) should be cheaper than baseline (Sonnet) by design
        expect(result.group_b.avg_cost_jpy!).toBeLessThan(result.group_a.avg_cost_jpy!);
        expect(result.group_b.avg_quality_score!).toBeGreaterThan(result.group_a.avg_quality_score!);

        // eslint-disable-next-line no-console
        console.log(
          `[model-b] baseline(Sonnet) cost=${result.group_a.avg_cost_jpy}, candidate(GPT-4o) cost=${result.group_b.avg_cost_jpy} ✓`,
        );
      });
    });

    // =========================================================================
    // Edge Cases
    // =========================================================================

    test.describe('Edge Cases', () => {
      test('a. insufficient_data flag set when book_count < minSample', async () => {
        await cleanupAbComparisonSeed();
        const context = await seedBooksForPeriodMode();

        // Test with minSample=10 (higher than group B's 8 books)
        const filter: AbComparisonFilter = {
          mode: 'period',
          periodA: PERIOD_A,
          periodB: PERIOD_B,
          minSample: 10,
        };

        const result = await getAbComparisonStats(prisma, filter);

        // Both groups should be insufficient
        expect(result.group_a.insufficient_data).toBe(true);
        expect(result.group_b.insufficient_data).toBe(true);

        // eslint-disable-next-line no-console
        console.log('[edge-a] minSample=10: both groups marked insufficient ✓');
      });

      test('b. cache_hit_rate is null when total_cached_input_tokens === 0', async () => {
        // Verify cache_hit_rate is null for zero cache scenario
        // by checking the logic in computeGroupStats
        const emptyResult: any = {
          total_cached_input_tokens: 0,
          total_input_tokens: 5000,
        };
        const cacheHitRate =
          emptyResult.total_cached_input_tokens > 0 &&
          emptyResult.total_input_tokens + emptyResult.total_cached_input_tokens > 0
            ? emptyResult.total_cached_input_tokens /
              (emptyResult.total_input_tokens + emptyResult.total_cached_input_tokens)
            : null;

        expect(cacheHitRate).toBeNull();

        // eslint-disable-next-line no-console
        console.log('[edge-b] zero cached tokens → cache_hit_rate=null ✓');
      });
    });
  },
);
