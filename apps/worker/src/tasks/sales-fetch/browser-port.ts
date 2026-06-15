/**
 * KDP ブラウザ操作の抽象ポート（DI 境界）[F-038]
 *
 * 本 SP-12 では実 Playwright を使わない。
 * Phase 3 (SP-14) で `BrowserPort` を満たす実装（Playwright + stealth）を提供する。
 *
 * HARD RULE: このファイルに `playwright` の import を書いてはならない。
 * Playwright 依存は Phase 3 のみ。
 */

export interface KdpCredentials {
  email: string;
  password: string;
  totp_secret?: string;
}

export interface FetchReportHtmlArgs {
  credentials: KdpCredentials;
  yearMonth: string;
  /** タイムアウト ms (既定 60_000) */
  timeoutMs?: number;
}

export type FetchReportHtmlResult =
  | { ok: true; html: string; source: 'kdp_report_page' }
  | {
      ok: false;
      reason: '2fa_required' | 'login_failed' | 'timeout' | 'unknown';
      message: string;
    };

/**
 * KDP レポートページの HTML を取得するブラウザポート。
 * テストではフィクスチャ HTML を返すダミー、本番 (Phase 3) では Playwright 実装を注入。
 */
export type BrowserPort = {
  fetchReportHtml(args: FetchReportHtmlArgs): Promise<FetchReportHtmlResult>;
};

/**
 * Fixture HTML を返すダミー実装（単体テスト・E2E fixture テスト用）。
 * ネットワーク/ブラウザ不使用。
 */
export function createFixtureBrowserPort(fixtureHtml: string): BrowserPort {
  return {
    async fetchReportHtml(_args) {
      return { ok: true, html: fixtureHtml, source: 'kdp_report_page' };
    },
  };
}

/**
 * 常に 2FA 要求を返すダミー（2FA ハンドリングテスト用）。
 */
export function create2faBrowserPort(): BrowserPort {
  return {
    async fetchReportHtml(_args) {
      return { ok: false, reason: '2fa_required', message: '2FA required (test dummy)' };
    },
  };
}
