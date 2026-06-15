import { EmailLayout, appUrl } from './_layout.js';
import { JUDGE_NEEDS_REVIEW } from './i18n.js';

/**
 * F-008 品質審査 3 回失敗時の通知 (pipeline-book-judge §8-C)。
 * score_total < 80 かつ retry_count >= 2 で Book.status='needs_human_review' に遷移したときに送る。
 */

export interface JudgeNeedsReviewEmailProps {
  bookId: string;
  bookTitle: string;
  scoreTotal: number;
  retryCount: number;
}

export const JUDGE_NEEDS_REVIEW_SUBJECT = JUDGE_NEEDS_REVIEW.subject;

export function JudgeNeedsReviewEmail(props: JudgeNeedsReviewEmailProps) {
  const subject = JUDGE_NEEDS_REVIEW.subject(props.bookTitle);
  const body = JUDGE_NEEDS_REVIEW.body({
    bookTitle: props.bookTitle,
    scoreTotal: props.scoreTotal,
    retryCount: props.retryCount,
  });
  return (
    <EmailLayout
      preview={subject}
      heading={JUDGE_NEEDS_REVIEW.heading}
      paragraphs={body.split('\n')}
      cta={{
        href: appUrl(`/books/${props.bookId}`),
        label: JUDGE_NEEDS_REVIEW.ctaLabel,
      }}
    />
  );
}

export function buildJudgeNeedsReviewEmail(props: JudgeNeedsReviewEmailProps) {
  return {
    subject: JUDGE_NEEDS_REVIEW.subject(props.bookTitle),
    react: <JudgeNeedsReviewEmail {...props} />,
  };
}
