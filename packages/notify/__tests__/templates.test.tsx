import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { render } from '@react-email/render';

import {
  buildCostExceededEmail,
  buildDbBackupFailedEmail,
  buildMonthlyBudgetAlertEmail,
  buildPricingChangedEmail,
  buildRevisionRunCompletedEmail,
  COST_EXCEEDED_SUBJECT,
  costExceededSubject,
  DB_BACKUP_FAILED_SUBJECT,
  MONTHLY_BUDGET_ALERT_SUBJECT,
  monthlyBudgetAlertSubject,
  PRICING_CHANGED_SUBJECT,
  REVISION_RUN_COMPLETED_SUBJECT,
} from '../src/templates/index.js';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_APP_URL = 'https://a2p.test';
});

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, ORIG_ENV);
});

describe('email templates', () => {
  it('cost-exceeded (warn): HTML + text + S-024 CTA link', async () => {
    const built = buildCostExceededEmail({
      bookId: 'book_abc',
      bookTitle: 'テスト書籍',
      costJpy: 612,
      limitJpy: 500,
      status: 'warn',
    });
    expect(built.subject).toContain('[A2P]');
    expect(built.subject).toContain('テスト書籍');
    const html = await render(built.react);
    expect(html).toContain('テスト書籍');
    expect(html).toContain('612');
    expect(html).toContain('500');
    expect(html).toContain('警告閾値');
    expect(html).toContain('https://a2p.test/cost');
    const text = await render(built.react, { plainText: true });
    expect(text).toContain('テスト書籍');
    expect(text).toContain('612');
  });

  it('cost-exceeded (paused): mentions paused status', async () => {
    const built = buildCostExceededEmail({
      bookId: 'book_abc',
      bookTitle: '停止本',
      costJpy: 800,
      limitJpy: 750,
      status: 'paused',
    });
    expect(built.subject).toContain('停止本');
    const html = await render(built.react);
    expect(html).toContain('一時停止');
    expect(html).toContain('停止閾値');
    expect(html).toContain('800');
    expect(html).toContain('750');
  });

  it('cost-exceeded subject includes book title dynamically', () => {
    const subject = costExceededSubject('入門 Python');
    expect(subject).toBe('[A2P] 書籍コスト警告: 入門 Python');
  });

  it('COST_EXCEEDED_SUBJECT is a function', () => {
    expect(typeof COST_EXCEEDED_SUBJECT).toBe('function');
  });

  it('monthly-budget-alert: subject includes percentage', () => {
    const subject = monthlyBudgetAlertSubject(80);
    expect(subject).toBe('[A2P] 月次コスト予測アラート (80%)');
  });

  it('monthly-budget-alert: body includes usage/predicted/budget/ratio/days', async () => {
    const built = buildMonthlyBudgetAlertEmail({
      month: '2026-05',
      usageJpy: 40000,
      predictedJpy: 48000,
      budgetJpy: 50000,
      ratio: 0.8,
      elapsedDays: 15,
      totalDays: 31,
    });
    expect(built.subject).toContain('80%');
    const html = await render(built.react);
    expect(html).toContain('2026-05');
    expect(html).toContain('40,000');
    expect(html).toContain('48,000');
    expect(html).toContain('50,000');
    expect(html).toContain('80%');
    expect(html).toContain('15');
    expect(html).toContain('31');
    expect(html).toContain('https://a2p.test/cost');
  });

  it('MONTHLY_BUDGET_ALERT_SUBJECT is a function', () => {
    expect(typeof MONTHLY_BUDGET_ALERT_SUBJECT).toBe('function');
  });

  it('pricing-changed: old/new price and signed delta', async () => {
    const built = buildPricingChangedEmail({
      model: 'claude-opus-4-7',
      oldUsdPerMtok: 15,
      newUsdPerMtok: 18,
      deltaPct: 20,
    });
    expect(built.subject).toBe(PRICING_CHANGED_SUBJECT);
    const html = await render(built.react);
    expect(html).toContain('claude-opus-4-7');
    expect(html).toContain('15');
    expect(html).toContain('18');
    expect(html).toContain('+20.0%');
    expect(html).toContain('https://a2p.test/admin/model-catalog');
  });

  it('pricing-changed: negative delta', async () => {
    const built = buildPricingChangedEmail({
      model: 'gpt-image-1',
      oldUsdPerMtok: 2,
      newUsdPerMtok: 1.5,
      deltaPct: -25,
    });
    const html = await render(built.react);
    expect(html).toContain('-25.0%');
  });

  it('revision-run-completed: counts and link', async () => {
    const built = buildRevisionRunCompletedEmail({
      bookId: 'book_x',
      bookTitle: '修正対象本',
      revisionRunId: 'run_1',
      appliedCount: 7,
      skippedCount: 2,
      failedCount: 1,
    });
    expect(built.subject).toBe(REVISION_RUN_COMPLETED_SUBJECT);
    const html = await render(built.react);
    expect(html).toContain('修正対象本');
    expect(html).toContain('適用: 7 件');
    expect(html).toContain('スキップ: 2 件');
    expect(html).toContain('失敗: 1 件');
    expect(html).toContain('https://a2p.test/books/book_x/revisions/run_1');
  });

  it('NEXT_PUBLIC_APP_URL 未設定でもレンダーは成功する（リンクは相対）', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    const built = buildCostExceededEmail({
      bookId: 'book_y',
      bookTitle: 't',
      costJpy: 1,
      limitJpy: 1,
      status: 'warn',
    });
    const html = await render(built.react);
    expect(html).toContain('/cost');
  });

  it('db-backup-failed: attempt info and reason', async () => {
    const built = buildDbBackupFailedEmail({
      occurredAt: '2026-05-24T18:00:00Z',
      reason: 'pg_dump exited with code 1: connection refused',
      attempt: 2,
      maxAttempts: 3,
    });
    expect(built.subject).toBe(DB_BACKUP_FAILED_SUBJECT);
    const html = await render(built.react);
    expect(html).toContain('2026-05-24T18:00:00Z');
    expect(html).toContain('2/3');
    expect(html).toContain('pg_dump');
    expect(html).toContain('https://a2p.test/admin/jobs');
  });

  it('all subject functions produce [A2P] prefix', () => {
    expect(costExceededSubject('x').startsWith('[A2P]')).toBe(true);
    expect(monthlyBudgetAlertSubject(80).startsWith('[A2P]')).toBe(true);
    expect(PRICING_CHANGED_SUBJECT.startsWith('[A2P]')).toBe(true);
    expect(REVISION_RUN_COMPLETED_SUBJECT.startsWith('[A2P]')).toBe(true);
    expect(DB_BACKUP_FAILED_SUBJECT.startsWith('[A2P]')).toBe(true);
  });
});
