/**
 * KDP 本棚操作の抽象ポート (DI 境界) — 低品質本の取り下げ用。
 *
 * セッション再利用で本棚を操作し、書籍を「出版停止(unpublish)」および
 * 「アーカイブ(archive)」する。KDP は出版済み(ASIN付き)の本を完全削除できないため、
 * 「削除相当」はアーカイブ(本棚から外す・復元可)で実現する。
 *
 * HARD RULE: このファイルに playwright の import を書かない
 * (Playwright 依存は playwright-bookshelf-port.ts に閉じる)。
 */

export type TakedownMode = 'unpublish' | 'unpublish_archive';

export interface TakedownBookArgs {
  /** 復号済み Playwright storageState(JSON)。 */
  sessionState: string;
  /** 対象書籍の ASIN(完全一致で特定・誤爆防止)。 */
  asin: string;
  mode: TakedownMode;
  timeoutMs?: number;
}

export interface TakedownStep {
  step: 'unpublish' | 'archive';
  ok: boolean;
  note?: string;
}

export type TakedownBookResult =
  | { ok: true; steps: TakedownStep[]; finalState: string }
  | { ok: false; reason: 'session_expired' | 'not_found' | 'ambiguous' | 'action_failed' | 'timeout' | 'unknown'; message: string; steps?: TakedownStep[] };

export type BookshelfPort = {
  takedownBook(args: TakedownBookArgs): Promise<TakedownBookResult>;
};

/** 常に成功を返すダミー(テスト用)。 */
export function createFixtureBookshelfPort(finalState = 'archived'): BookshelfPort {
  return {
    async takedownBook(args) {
      const steps: TakedownStep[] = [{ step: 'unpublish', ok: true }];
      if (args.mode === 'unpublish_archive') steps.push({ step: 'archive', ok: true });
      return { ok: true, steps, finalState };
    },
  };
}

/** 常にセッション切れを返すダミー。 */
export function createSessionExpiredBookshelfPort(): BookshelfPort {
  return {
    async takedownBook() {
      return { ok: false, reason: 'session_expired', message: 'session expired (test dummy)' };
    },
  };
}
