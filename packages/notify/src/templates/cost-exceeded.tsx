import { EmailLayout, appUrl } from './_layout.js';
import { COMMON, COST_EXCEEDED } from './i18n.js';

/**
 * 1 冊あたりのコスト閾値を超過した際の通知 (F-034)。
 * warn (警告) と paused (一時停止) の 2 段階に対応。
 * CTA は S-024 コスト詳細ダッシュボードへリンク。
 */

export interface CostExceededEmailProps {
  bookId: string;
  bookTitle: string;
  costJpy: number;
  limitJpy: number;
  status: 'warn' | 'paused';
}

export function costExceededSubject(bookTitle: string): string {
  return COST_EXCEEDED.subject(bookTitle);
}

export const COST_EXCEEDED_SUBJECT = COST_EXCEEDED.subject;

export function CostExceededEmail(props: CostExceededEmailProps) {
  const subject = COST_EXCEEDED.subject(props.bookTitle);
  const body = COST_EXCEEDED.body({
    bookTitle: props.bookTitle,
    costJpy: props.costJpy,
    limitJpy: props.limitJpy,
    status: props.status,
  });
  return (
    <EmailLayout
      preview={subject}
      heading={COST_EXCEEDED.heading}
      paragraphs={body.split('\n')}
      cta={{ href: appUrl('/cost'), label: COMMON.ctaOpenCostPage }}
    />
  );
}

export function buildCostExceededEmail(props: CostExceededEmailProps) {
  return {
    subject: COST_EXCEEDED.subject(props.bookTitle),
    react: <CostExceededEmail {...props} />,
  };
}
