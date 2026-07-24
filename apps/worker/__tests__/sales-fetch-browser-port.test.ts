import { describe, expect, it } from 'vitest';

import {
  createFixtureBrowserPort,
  createSessionExpiredBrowserPort,
} from '../src/tasks/sales-fetch/browser-port.js';

const ARGS = { sessionState: '{"cookies":[],"origins":[]}', yearMonth: '2026-06' };

describe('createFixtureBrowserPort', () => {
  it('ok:true と buffer を返す', async () => {
    const buf = Buffer.from('PK\x03\x04 fake xlsx');
    const port = createFixtureBrowserPort(buf, 'r.xlsx');
    const result = await port.downloadReport(ARGS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.buffer).toBe(buf);
    expect(result.filename).toBe('r.xlsx');
  });

  it('timeoutMs 指定があっても ok:true', async () => {
    const port = createFixtureBrowserPort(Buffer.from('x'));
    const result = await port.downloadReport({ ...ARGS, timeoutMs: 5000 });
    expect(result.ok).toBe(true);
  });
});

describe('createSessionExpiredBrowserPort', () => {
  it('ok:false, reason:session_expired を返す', async () => {
    const port = createSessionExpiredBrowserPort();
    const result = await port.downloadReport(ARGS);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('session_expired');
    expect(result.message.length).toBeGreaterThan(0);
  });
});
