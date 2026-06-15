import { describe, expect, it } from 'vitest';

import {
  create2faBrowserPort,
  createFixtureBrowserPort,
} from '../src/tasks/sales-fetch/browser-port.js';

const DUMMY_CREDENTIALS = {
  email: 'test@example.com',
  password: 'password123',
};

const DUMMY_ARGS = {
  credentials: DUMMY_CREDENTIALS,
  yearMonth: '2026-05',
};

describe('createFixtureBrowserPort', () => {
  it('ok:true と fixture HTML を返す', async () => {
    const html = '<html><body>fixture report</body></html>';
    const port = createFixtureBrowserPort(html);
    const result = await port.fetchReportHtml(DUMMY_ARGS);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.html).toBe(html);
    expect(result.source).toBe('kdp_report_page');
  });

  it('異なる fixture HTML を受け取ってそのまま返す', async () => {
    const html = '<html><body>another report</body></html>';
    const port = createFixtureBrowserPort(html);
    const result = await port.fetchReportHtml({ ...DUMMY_ARGS, yearMonth: '2025-12' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.html).toBe(html);
  });

  it('timeoutMs 指定があっても ok:true を返す', async () => {
    const html = '<html/>';
    const port = createFixtureBrowserPort(html);
    const result = await port.fetchReportHtml({ ...DUMMY_ARGS, timeoutMs: 5000 });

    expect(result.ok).toBe(true);
  });
});

describe('create2faBrowserPort', () => {
  it('ok:false, reason:2fa_required を返す', async () => {
    const port = create2faBrowserPort();
    const result = await port.fetchReportHtml(DUMMY_ARGS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('2fa_required');
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('totp_secret ありの認証情報を渡しても 2fa_required を返す', async () => {
    const port = create2faBrowserPort();
    const result = await port.fetchReportHtml({
      credentials: { ...DUMMY_CREDENTIALS, totp_secret: 'JBSWY3DPEHPK3PXP' },
      yearMonth: '2026-05',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('2fa_required');
  });
});
