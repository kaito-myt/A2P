export {
  getResendClient,
  createResendClient,
  resolveResendApiKey,
  _setResendClientForTests,
  _resetResendClientForTests,
  type ResendLike,
} from './client.js';

export { sendEmail, type SendEmailParams, type SendEmailResult } from './email.js';

export * from './templates/index.js';
