import { EmailLayout, appUrl } from './_layout.js';
import { COMMON, REVISION_RUN_COMPLETED } from './i18n.js';

/**
 * F-050 一括修正反映の完了通知 (docs/05 §5.3.10 revision.book.apply 末尾)。
 * 本実装は SP-06 で行う。本タスクでは枠 + 文言のみ。
 */

export interface RevisionRunCompletedEmailProps {
  bookId: string;
  bookTitle: string;
  revisionRunId: string;
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
}

export const REVISION_RUN_COMPLETED_SUBJECT = REVISION_RUN_COMPLETED.subject;

export function RevisionRunCompletedEmail(props: RevisionRunCompletedEmailProps) {
  const body = REVISION_RUN_COMPLETED.body({
    bookTitle: props.bookTitle,
    appliedCount: props.appliedCount,
    skippedCount: props.skippedCount,
    failedCount: props.failedCount,
  });
  return (
    <EmailLayout
      preview={REVISION_RUN_COMPLETED.subject}
      heading={REVISION_RUN_COMPLETED.heading}
      paragraphs={body.split('\n')}
      cta={{
        href: appUrl(`/books/${props.bookId}/revisions/${props.revisionRunId}`),
        label: COMMON.ctaOpenRevisionRun,
      }}
    />
  );
}

export function buildRevisionRunCompletedEmail(props: RevisionRunCompletedEmailProps) {
  return {
    subject: REVISION_RUN_COMPLETED_SUBJECT,
    react: <RevisionRunCompletedEmail {...props} />,
  };
}
