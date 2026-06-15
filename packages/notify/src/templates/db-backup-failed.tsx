import { EmailLayout, appUrl } from './_layout.js';
import { COMMON, DB_BACKUP_FAILED } from './i18n.js';

/**
 * `archive.db.backup` (apps/worker) が失敗した際の運営者通知。
 * 本タスク (T-01-12) で枠と本実装を兼ねる。
 */

export interface DbBackupFailedEmailProps {
  /** 失敗発生時刻 (ISO 8601 文字列推奨)。 */
  occurredAt: string;
  /** 失敗理由 (`error.message` 抜粋)。 */
  reason: string;
  /** 今回が何回目の試行か (1-origin)。 */
  attempt: number;
  /** graphile-worker の `max_attempts` (失敗継続時の最終リトライ回数)。 */
  maxAttempts: number;
}

export const DB_BACKUP_FAILED_SUBJECT = DB_BACKUP_FAILED.subject;

export function DbBackupFailedEmail(props: DbBackupFailedEmailProps) {
  const body = DB_BACKUP_FAILED.body({
    occurredAt: props.occurredAt,
    reason: props.reason,
    attempt: props.attempt,
    maxAttempts: props.maxAttempts,
  });
  return (
    <EmailLayout
      preview={DB_BACKUP_FAILED.subject}
      heading={DB_BACKUP_FAILED.heading}
      paragraphs={body.split('\n')}
      cta={{ href: appUrl('/admin/jobs'), label: COMMON.ctaOpenDashboard }}
    />
  );
}

export function buildDbBackupFailedEmail(props: DbBackupFailedEmailProps) {
  return {
    subject: DB_BACKUP_FAILED_SUBJECT,
    react: <DbBackupFailedEmail {...props} />,
  };
}
