import { EmailLayout, appUrl } from './_layout.js';
import { COMMON, MONTHLY_BUDGET_ALERT } from './i18n.js';

/**
 * 月次予算の 80% / 95% / 100% 到達アラート (F-036)。
 * CTA は S-024 コスト詳細ダッシュボードへリンク。
 */

export interface MonthlyBudgetAlertEmailProps {
  /** "2026-05" 等の年月。 */
  month: string;
  usageJpy: number;
  predictedJpy: number;
  budgetJpy: number;
  /** 0..1。80%/95%/100% の閾値到達を表す。 */
  ratio: number;
  elapsedDays: number;
  totalDays: number;
}

export function monthlyBudgetAlertSubject(percentage: number): string {
  return MONTHLY_BUDGET_ALERT.subject(percentage);
}

export const MONTHLY_BUDGET_ALERT_SUBJECT = MONTHLY_BUDGET_ALERT.subject;

export function MonthlyBudgetAlertEmail(props: MonthlyBudgetAlertEmailProps) {
  const percentage = Math.round(props.ratio * 100);
  const subject = MONTHLY_BUDGET_ALERT.subject(percentage);
  const body = MONTHLY_BUDGET_ALERT.body({
    month: props.month,
    usageJpy: props.usageJpy,
    predictedJpy: props.predictedJpy,
    budgetJpy: props.budgetJpy,
    ratio: props.ratio,
    elapsedDays: props.elapsedDays,
    totalDays: props.totalDays,
  });
  return (
    <EmailLayout
      preview={subject}
      heading={MONTHLY_BUDGET_ALERT.heading}
      paragraphs={body.split('\n')}
      cta={{ href: appUrl('/cost'), label: COMMON.ctaOpenCostPage }}
    />
  );
}

export function buildMonthlyBudgetAlertEmail(props: MonthlyBudgetAlertEmailProps) {
  return {
    subject: MONTHLY_BUDGET_ALERT.subject(Math.round(props.ratio * 100)),
    react: <MonthlyBudgetAlertEmail {...props} />,
  };
}
