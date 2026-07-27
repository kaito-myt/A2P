import type { Task } from 'graphile-worker';

import { createLogger, type Logger } from '@a2p/contracts/logger';
import { decryptKdpCredentials } from '@a2p/crypto';
import { prisma as defaultPrisma } from '@a2p/db';

import { isLineRelayConfigured, pushLine } from './lib/line-auth-relay.js';
import type { BookshelfPort } from './book-cull/bookshelf-port.js';

/**
 * `kdp.publish.status.sync` タスク — KDP 本棚を READ-ONLY で巡回し、`publish_status='submitted'`
 * の本が実際に KDP で LIVE (販売中) になっていたら自動で `published` に昇格させる。
 *
 * ローカルのアシスト出版ツール (`scripts/kdp-publish.mjs`) は入稿成功時点で `submitted` に
 * するだけで、実際にいつ Amazon 側の審査が通り LIVE になるかまでは分からない。本タスクが
 * 保存済みセッション再利用でヘッドレス閲覧し、そのギャップを埋める。
 *
 * 安全策 (READ-ONLY): ログイン/出版/取り下げ等の状態変更操作は一切行わない。セッション切れを
 * 検知した場合は LINE 通知のうえ即座にループを打ち切る (再ログイン試行は行わない — 別タスクの
 * 責務外)。
 */
export const KDP_PUBLISH_STATUS_SYNC_TASK_NAME = 'kdp.publish.status.sync';

// ---------------------------------------------------------------------------
// Prisma 最小インターフェース — テストでモック可能にする。
// ---------------------------------------------------------------------------

export interface KdpPublishStatusSyncPrisma {
  account: {
    findFirst(args: {
      where: { status: string };
      select: { id: true; kdp_session_state_enc: true };
      orderBy: { created_at: 'asc' };
    }): Promise<{ id: string; kdp_session_state_enc: string | null } | null>;
  };
  book: {
    findMany(args: {
      where: { publish_status: string };
      select: { id: true; asin: true; title: true };
    }): Promise<Array<{ id: string; asin: string | null; title: string }>>;
    update(args: {
      where: { id: string };
      data: { publish_status: string; updated_at: Date };
    }): Promise<unknown>;
  };
  auditLog: {
    create(args: {
      data: {
        actor_id: string | null;
        action: string;
        target_kind: string;
        target_id: string;
        before_json?: Record<string, unknown>;
        after_json?: Record<string, unknown>;
      };
    }): Promise<unknown>;
  };
}

export interface KdpPublishStatusSyncDeps {
  bookshelfPort: BookshelfPort;
  prisma?: KdpPublishStatusSyncPrisma;
  logger?: Logger;
  now?: () => Date;
}

export interface KdpPublishStatusSyncResult {
  checked: number;
  promoted: number;
}

// ---------------------------------------------------------------------------
// 純ロジック関数
// ---------------------------------------------------------------------------

export async function runKdpPublishStatusSync(
  deps: KdpPublishStatusSyncDeps,
): Promise<KdpPublishStatusSyncResult> {
  const log = deps.logger ?? createLogger(`worker.${KDP_PUBLISH_STATUS_SYNC_TASK_NAME}`);
  const db = deps.prisma ?? (defaultPrisma as unknown as KdpPublishStatusSyncPrisma);
  const now = deps.now ?? (() => new Date());

  // 1. アカウント + セッション取得 (単一運営者 = 作成日最古の active アカウントを対象とする)
  const account = await db.account.findFirst({
    where: { status: 'active' },
    select: { id: true, kdp_session_state_enc: true },
    orderBy: { created_at: 'asc' },
  });
  if (!account) {
    log.info({ task: KDP_PUBLISH_STATUS_SYNC_TASK_NAME }, '有効な KDP アカウントが無いためスキップ');
    return { checked: 0, promoted: 0 };
  }
  if (!account.kdp_session_state_enc) {
    log.info(
      { task: KDP_PUBLISH_STATUS_SYNC_TASK_NAME, accountId: account.id },
      'KDP セッション未設定のためスキップ',
    );
    return { checked: 0, promoted: 0 };
  }

  let sessionState: string;
  try {
    sessionState = decryptKdpCredentials(account.kdp_session_state_enc);
  } catch (err) {
    log.warn({ err, accountId: account.id }, 'KDP セッションの復号に失敗したためスキップ');
    return { checked: 0, promoted: 0 };
  }

  // 2. 入稿済み(未LIVE確認)の本を全件取得
  const books = await db.book.findMany({
    where: { publish_status: 'submitted' },
    select: { id: true, asin: true, title: true },
  });

  let checked = 0;
  let promoted = 0;

  for (const book of books) {
    checked++;
    let res;
    try {
      res = await deps.bookshelfPort.readBookStatus({
        asin: book.asin ?? undefined,
        title: book.title,
        sessionState,
      });
    } catch (err) {
      log.warn({ err, bookId: book.id }, 'readBookStatus が例外を投げたためこの本はスキップ');
      continue;
    }

    if (!res.ok) {
      if (res.reason === 'session_expired') {
        log.warn(
          { task: KDP_PUBLISH_STATUS_SYNC_TASK_NAME, bookId: book.id },
          'KDP セッション期限切れを検知 — 同期を中断',
        );
        if (isLineRelayConfigured()) {
          await pushLine('KDP本棚の閲覧セッションが切れています。売上取得などで再ログインが必要です。').catch(
            () => {},
          );
        }
        break; // 以降ヒットしても同じ結果なので走査を打ち切る (連打を避ける)
      }
      log.warn(
        { bookId: book.id, reason: res.reason, message: res.message },
        'KDP ステータス取得に失敗 — この本はスキップ',
      );
      continue;
    }

    if (res.status !== 'live') continue;

    try {
      await db.book.update({
        where: { id: book.id },
        data: { publish_status: 'published', updated_at: now() },
      });
      await db.auditLog.create({
        data: {
          actor_id: null, // cron 起動 = システム実行
          action: 'kdp.publish.published',
          target_kind: 'book',
          target_id: book.id,
          before_json: { publish_status: 'submitted' },
          after_json: { publish_status: 'published', detected_status: res.status },
        },
      });
      promoted++;
      log.info({ task: KDP_PUBLISH_STATUS_SYNC_TASK_NAME, bookId: book.id }, 'LIVE 検知 → published に昇格');
    } catch (err) {
      log.warn({ err, bookId: book.id }, 'published への更新に失敗');
    }
  }

  log.info(
    { task: KDP_PUBLISH_STATUS_SYNC_TASK_NAME, checked, promoted },
    'kdp.publish.status.sync done',
  );
  return { checked, promoted };
}

// ---------------------------------------------------------------------------
// graphile-worker Task 薄ラッパ
// ---------------------------------------------------------------------------

export const kdpPublishStatusSyncTask: Task = async () => {
  const { createPlaywrightBookshelfPort } = await import('./book-cull/playwright-bookshelf-port.js');
  await runKdpPublishStatusSync({ bookshelfPort: createPlaywrightBookshelfPort() });
};
