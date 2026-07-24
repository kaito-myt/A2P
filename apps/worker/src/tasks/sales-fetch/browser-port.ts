/**
 * KDP レポート取得の抽象ポート (DI 境界) [F-038 / Phase2 自動取得]。
 *
 * セッション再利用方式: 運営者が一度手動ログインして保存した storageState
 * (accounts.kdp_session_state_enc を復号したもの) をワーカーが再利用し、KDP の
 * 月別ロイヤリティ(PMR)レポート xlsx を **ダウンロード**する。
 *
 * KDP の DL は 2 段 GET (DOM 操作不要):
 *   1) GET kdpreports.amazon.co.jp/download/report/pmr/ja_JP/pmrReport.xslx
 *        ?selectedMonth=YYYY-MM&reportType=KDP_PMR   → JSON { url: <S3署名URL> }
 *   2) GET <S3署名URL>                                → xlsx バイナリ
 *
 * HARD RULE: このファイルに `playwright` の import を書いてはならない
 *   (Playwright 依存は playwright-browser-port.ts に閉じる)。
 */

export interface DownloadReportArgs {
  /** 復号済み Playwright storageState(JSON 文字列)。ログイン済み Cookie を含む。 */
  sessionState: string;
  /** 取得対象月 YYYY-MM。 */
  yearMonth: string;
  /** タイムアウト ms (既定 60_000)。 */
  timeoutMs?: number;
}

export type DownloadReportResult =
  | { ok: true; buffer: Buffer; filename: string | null }
  | {
      ok: false;
      reason: 'session_expired' | 'download_failed' | 'timeout' | 'unknown';
      message: string;
    };

/**
 * KDP レポート xlsx を取得するブラウザポート。
 * テストではダミー、本番では Playwright 実装を注入。
 */
export type BrowserPort = {
  downloadReport(args: DownloadReportArgs): Promise<DownloadReportResult>;
};

/** 固定バッファを返すダミー実装 (単体テスト用)。ネットワーク/ブラウザ不使用。 */
export function createFixtureBrowserPort(buffer: Buffer, filename = 'fixture.xlsx'): BrowserPort {
  return {
    async downloadReport() {
      return { ok: true, buffer, filename };
    },
  };
}

/** 常にセッション切れを返すダミー (期限切れハンドリングテスト用)。 */
export function createSessionExpiredBrowserPort(): BrowserPort {
  return {
    async downloadReport() {
      return { ok: false, reason: 'session_expired', message: 'session expired (test dummy)' };
    },
  };
}
