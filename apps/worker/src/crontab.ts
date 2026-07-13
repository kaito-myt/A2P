import { type CronItem, parseCronItems, type ParsedCronItem } from 'graphile-worker';

import { ALERT_COST_CHECK_TASK_NAME } from './tasks/alert-cost-check.js';
import { ARCHIVE_DB_BACKUP_TASK_NAME } from './tasks/archive-db-backup.js';
import { ARCHIVE_JOBS_TASK_NAME } from './tasks/archive-jobs.js';
import { BATCH_PLAN_DISPATCHER_TASK_NAME } from './tasks/batch-plan-dispatcher.js';
import { CATALOG_FETCH_TASK_NAME } from './tasks/catalog-fetch.js';
import { FX_FETCH_TASK_NAME } from './tasks/fx-fetch.js';
import { SALES_FETCH_DISPATCHER_TASK_NAME } from './tasks/sales-fetch-dispatcher.js';
import { PROMOTION_DISPATCH_TASK_NAME } from './tasks/promotion-dispatch.js';
import { ORG_PLAN_TASK_NAME } from './tasks/org-plan.js';
import { ORG_EXECUTE_DISPATCH_TASK_NAME } from './tasks/org-execute.js';
import { ORG_OPS_WATCH_TASK_NAME } from './tasks/org-ops-watch.js';
import { ORG_FINANCE_TICK_TASK_NAME } from './tasks/org-finance-tick.js';
import { ORG_KDP_SCREEN_TASK_NAME } from './tasks/org-kdp-screen.js';

/**
 * graphile-worker cron 定義 (docs/05 §5.4 / SP-01 仕様: `apps/worker/src/crontab.ts`)
 *
 * docs/05 §5.1 ではタスク名にドット表記 (`pipeline.book.kickoff`) を採用しているが、
 * graphile-worker 0.16 の crontab 文字列パーサ (`CRONTAB_COMMAND` 正規表現:
 * `^([_a-zA-Z][_a-zA-Z0-9:_-]*)...`) はドットを許容しない。一方で `CronItem` の
 * プログラマティック API はタスク名に制約がないため、本ファイルでは `CronItem[]` を
 * 直接生成して `parseCronItems()` に渡す方式を採用する（docs/05 §5.1 の命名規約と
 * graphile-worker の cron 文字列制約を両立するための実装上の決定）。
 *
 * Phase 1 (SP-01) 時点で有効化する cron:
 *   - `archive.db.backup`: 週次 pg_dump → R2 退避 (R-12 緩和)
 *
 * Phase 1 後半 / Phase 2 で有効化する cron は docs/05 §5.4 に列挙。各 SP でタスク本実装
 * とセットで本配列に追記する運用とする。
 */

/**
 * 毎週土曜 18:00 UTC = 日曜 03:00 JST。docs/03 R-12 緩和 (Railway 障害時の R2 復元手段)。
 *
 * graphile-worker の cron は UTC ベース:
 *   日曜 03:00 JST = 土曜 18:00 UTC → `0 18 * * 6`
 * docs/05 §5.4 に「日曜 03:00 JST」と記載されているため、土曜 18:00 UTC で起動する。
 */
export const ARCHIVE_DB_BACKUP_CRON = '0 18 * * 6';

/**
 * SP-02 T-02-07: 毎時 0 分に期限切れ BookLock を掃除。
 * docs/05 OQ-D-05 で運用方針が確定 (「必要なら alert.cost.check と同 cron で掃除」)、
 * かつ docs/05 §14 #4 で BookLock は `expires_at` 自動解放と定められているため。
 */
export const LOCKS_SWEEP_CRON = '0 * * * *';

/**
 * SP-02 T-02-08: 日次の為替レート取得。
 * `55 18 * * *` UTC = JST 03:55。catalog.fetch (T-02-09, JST 04:00) より 5 分前に
 * 走らせて `AppSettings.latest_fx_rate` を更新しておく (docs/05 §5.4 と整合)。
 */
export const FX_FETCH_CRON = '55 18 * * *';

/**
 * SP-02 T-02-09: 日次の単価カタログ取得。
 * env `MODEL_CATALOG_FETCH_CRON` (既定 `0 19 * * *` UTC = JST 04:00) を使用 (docs/05 §5.4)。
 * fx.fetch (`55 18 * * *`) の 5 分後に走らせ、`AppSettings.latest_fx_rate` を
 * 同日分のレートとして利用する。
 */
export const CATALOG_FETCH_CRON_DEFAULT = '0 19 * * *';

/**
 * SP-03 T-03-10: 毎分 batch_plan のスケジュール起動チェック。
 * `BatchPlan.status='scheduled' AND planned_at <= now()` の plan を一括 kick する
 * (docs/05 §5.4 / F-021)。1 分粒度で十分 (BatchPlan の planned_at は分単位)。
 */
export const BATCH_PLAN_DISPATCHER_CRON = '* * * * *';

/**
 * SP-07 T-07-02: 毎時 0 分にコストアラートチェック (docs/05 §5.4)。
 * `0 * * * *` UTC — monthly scope は毎時、per_book scope は個別 enqueue。
 */
export const ALERT_COST_CHECK_CRON = '0 * * * *';

/**
 * T-09-04: 毎週日曜 03:00 JST = 土曜 18:00 UTC (docs/05 §5.3.18)。
 * archive.db.backup (`0 18 * * 6`) と同スケジュール — 日曜朝メンテナンスウィンドウ統一。
 */
export const ARCHIVE_JOBS_CRON = '0 18 * * 6';

/** env から catalog cron を取得 (既定 `0 19 * * *`)。 */
export function resolveCatalogFetchCron(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.MODEL_CATALOG_FETCH_CRON;
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return CATALOG_FETCH_CRON_DEFAULT;
}

/**
 * SP-12 T-12-05: 日次の売上自動取得 dispatcher。
 * `0 17 * * *` UTC = JST 02:00。docs/05 §5.4 / F-038。
 * このエントリは CRON_ITEMS に静的追加せず、`buildCronItemsWithSettings` で条件付き追加する。
 */
export const SALES_FETCH_CRON_DEFAULT = '0 17 * * *'; // 02:00 JST

/** env から sales.fetch.dispatch cron を取得 (既定 `0 17 * * *`)。 */
export function resolveSalesFetchCron(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.SALES_FETCH_CRON;
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return SALES_FETCH_CRON_DEFAULT;
}

/** `sales.fetch.dispatch` の CronItem 定義 (AppSettings.sales_auto_fetch_enabled=true のときのみ使用)。 */
export const SALES_FETCH_DISPATCH_CRON_ITEM: CronItem = {
  task: SALES_FETCH_DISPATCHER_TASK_NAME,
  match: resolveSalesFetchCron(),
  identifier: 'sales-fetch-dispatch-daily',
};

/**
 * F-052: 販促投稿の自動ディスパッチ cron (既定 30分毎)。
 * AppSettings.promo_auto_post_enabled=true のときだけ条件付き追加する。
 */
export const PROMOTION_DISPATCH_CRON_DEFAULT = '*/30 * * * *';

/** `promotion.dispatch` の CronItem 定義。 */
export const PROMOTION_DISPATCH_CRON_ITEM: CronItem = {
  task: PROMOTION_DISPATCH_TASK_NAME,
  match: PROMOTION_DISPATCH_CRON_DEFAULT,
  identifier: 'promotion-dispatch',
};

/**
 * docs/06: CEO ティック (org.plan) の日次 cron。既定 05:00 JST (UTC 20:00)。
 * AppSettings.org_auto_plan_enabled=true のときだけ条件付き追加する。
 */
export const ORG_PLAN_CRON_DEFAULT = '0 20 * * *';

/** `org.plan` の CronItem 定義。 */
export const ORG_PLAN_CRON_ITEM: CronItem = {
  task: ORG_PLAN_TASK_NAME,
  match: ORG_PLAN_CRON_DEFAULT,
  identifier: 'org-plan-daily',
  payload: { trigger: 'cron' },
};

/**
 * docs/06 P2: 承認済 org_tasks の実行ディスパッチ (org.execute.dispatch)。既定 15分毎。
 * AppSettings.org_auto_execute_enabled=true のときだけ条件付き追加する。
 */
export const ORG_EXECUTE_CRON_DEFAULT = '*/15 * * * *';

/** `org.execute.dispatch` の CronItem 定義。 */
export const ORG_EXECUTE_CRON_ITEM: CronItem = {
  task: ORG_EXECUTE_DISPATCH_TASK_NAME,
  match: ORG_EXECUTE_CRON_DEFAULT,
  identifier: 'org-execute-dispatch',
  payload: { trigger: 'cron' },
};

/**
 * docs/06 P3: 運用の自己復旧監視 (org.ops.watch)。既定 10分毎。
 * AppSettings.org_ops_watch_enabled=true のときだけ条件付き追加する。
 */
export const ORG_OPS_WATCH_CRON_DEFAULT = '*/10 * * * *';

/** `org.ops.watch` の CronItem 定義。 */
export const ORG_OPS_WATCH_CRON_ITEM: CronItem = {
  task: ORG_OPS_WATCH_TASK_NAME,
  match: ORG_OPS_WATCH_CRON_DEFAULT,
  identifier: 'org-ops-watch',
  payload: { trigger: 'cron' },
};

/**
 * docs/06 P3: 経営の予算ガード (org.finance.tick)。既定 毎時。
 * AppSettings.org_finance_tick_enabled=true のときだけ条件付き追加する。
 */
export const ORG_FINANCE_TICK_CRON_DEFAULT = '0 * * * *';

/** `org.finance.tick` の CronItem 定義。 */
export const ORG_FINANCE_TICK_CRON_ITEM: CronItem = {
  task: ORG_FINANCE_TICK_TASK_NAME,
  match: ORG_FINANCE_TICK_CRON_DEFAULT,
  identifier: 'org-finance-tick',
  payload: { trigger: 'cron' },
};

/**
 * docs/06 P4 増分3: KDP 公開の事前スクリーニング (org.kdp.screen)。既定 毎時30分。
 * AppSettings.org_kdp_auto_publish_enabled=true のときだけ条件付き追加する（既定OFF）。
 */
export const ORG_KDP_SCREEN_CRON_DEFAULT = '30 * * * *';

/** `org.kdp.screen` の CronItem 定義。 */
export const ORG_KDP_SCREEN_CRON_ITEM: CronItem = {
  task: ORG_KDP_SCREEN_TASK_NAME,
  match: ORG_KDP_SCREEN_CRON_DEFAULT,
  identifier: 'org-kdp-screen',
  payload: { trigger: 'cron' },
};

/** AppSettings の自動運用トグルに応じて CronItem 配列を組み立てる。 */
export interface CronRuntimeSettings {
  sales_auto_fetch_enabled: boolean;
  /** DB に保存されている cron 文字列 (省略時は env / 既定値を使用)。 */
  sales_auto_fetch_cron?: string | null;
  /** F-052: 販促自動投稿ディスパッチャを有効化するか。 */
  promo_auto_post_enabled?: boolean;
  /** F-052: 販促ディスパッチ cron (省略時は既定 30分毎)。 */
  promo_dispatch_cron?: string | null;
  /** docs/06: CEO ティック (org.plan) を日次 cron で自動起動するか。 */
  org_auto_plan_enabled?: boolean;
  /** docs/06: org.plan cron (省略時は既定 05:00 JST)。 */
  org_plan_cron?: string | null;
  /** docs/06 P2: 承認済タスクの実行ディスパッチ (org.execute.dispatch) を cron 有効化するか。 */
  org_auto_execute_enabled?: boolean;
  /** docs/06 P2: org.execute.dispatch cron (省略時は既定 15分毎)。 */
  org_execute_cron?: string | null;
  /** docs/06 P3: 運用の自己復旧監視 (org.ops.watch) を cron 有効化するか。 */
  org_ops_watch_enabled?: boolean;
  /** docs/06 P3: org.ops.watch cron (省略時は既定 10分毎)。 */
  org_ops_watch_cron?: string | null;
  /** docs/06 P3: 経営の予算ガード (org.finance.tick) を cron 有効化するか。 */
  org_finance_tick_enabled?: boolean;
  /** docs/06 P3: org.finance.tick cron (省略時は既定 毎時)。 */
  org_finance_tick_cron?: string | null;
  /** docs/06 P4 増分3: KDP 公開の事前スクリーニング (org.kdp.screen) を cron 有効化するか（既定OFF）。 */
  org_kdp_auto_publish_enabled?: boolean;
  /** docs/06 P4 増分3: org.kdp.screen cron (省略時は既定 毎時30分)。 */
  org_kdp_screen_cron?: string | null;
}

/** 後方互換エイリアス (旧名)。 */
export type SalesFetchSettings = CronRuntimeSettings;

/**
 * AppSettings を受け取り、最終的な CronItem[] を返す。
 *
 * - 静的 CRON_ITEMS は常に含む
 * - `sales_auto_fetch_enabled=true`  → + sales.fetch.dispatch
 * - `promo_auto_post_enabled=true`   → + promotion.dispatch
 */
export function buildCronItemsWithSettings(settings: CronRuntimeSettings): CronItem[] {
  const items: CronItem[] = [...CRON_ITEMS];

  if (settings.sales_auto_fetch_enabled) {
    const cronMatch =
      typeof settings.sales_auto_fetch_cron === 'string' &&
      settings.sales_auto_fetch_cron.trim().length > 0
        ? settings.sales_auto_fetch_cron.trim()
        : resolveSalesFetchCron();
    items.push({ ...SALES_FETCH_DISPATCH_CRON_ITEM, match: cronMatch });
  }

  if (settings.promo_auto_post_enabled) {
    const cronMatch =
      typeof settings.promo_dispatch_cron === 'string' &&
      settings.promo_dispatch_cron.trim().length > 0
        ? settings.promo_dispatch_cron.trim()
        : PROMOTION_DISPATCH_CRON_DEFAULT;
    items.push({ ...PROMOTION_DISPATCH_CRON_ITEM, match: cronMatch });
  }

  if (settings.org_auto_plan_enabled) {
    const cronMatch =
      typeof settings.org_plan_cron === 'string' && settings.org_plan_cron.trim().length > 0
        ? settings.org_plan_cron.trim()
        : ORG_PLAN_CRON_DEFAULT;
    items.push({ ...ORG_PLAN_CRON_ITEM, match: cronMatch });
  }

  if (settings.org_auto_execute_enabled) {
    const cronMatch =
      typeof settings.org_execute_cron === 'string' && settings.org_execute_cron.trim().length > 0
        ? settings.org_execute_cron.trim()
        : ORG_EXECUTE_CRON_DEFAULT;
    items.push({ ...ORG_EXECUTE_CRON_ITEM, match: cronMatch });
  }

  if (settings.org_ops_watch_enabled) {
    const cronMatch =
      typeof settings.org_ops_watch_cron === 'string' && settings.org_ops_watch_cron.trim().length > 0
        ? settings.org_ops_watch_cron.trim()
        : ORG_OPS_WATCH_CRON_DEFAULT;
    items.push({ ...ORG_OPS_WATCH_CRON_ITEM, match: cronMatch });
  }

  if (settings.org_finance_tick_enabled) {
    const cronMatch =
      typeof settings.org_finance_tick_cron === 'string' && settings.org_finance_tick_cron.trim().length > 0
        ? settings.org_finance_tick_cron.trim()
        : ORG_FINANCE_TICK_CRON_DEFAULT;
    items.push({ ...ORG_FINANCE_TICK_CRON_ITEM, match: cronMatch });
  }

  if (settings.org_kdp_auto_publish_enabled) {
    const cronMatch =
      typeof settings.org_kdp_screen_cron === 'string' && settings.org_kdp_screen_cron.trim().length > 0
        ? settings.org_kdp_screen_cron.trim()
        : ORG_KDP_SCREEN_CRON_DEFAULT;
    items.push({ ...ORG_KDP_SCREEN_CRON_ITEM, match: cronMatch });
  }

  return items;
}

export const CRON_ITEMS: CronItem[] = [
  {
    task: ARCHIVE_DB_BACKUP_TASK_NAME,
    match: ARCHIVE_DB_BACKUP_CRON,
    identifier: 'archive-db-backup-weekly',
    // payload は不要 (タスク本体は env と helpers.job から状態を取る)
  },
  {
    task: FX_FETCH_TASK_NAME,
    match: FX_FETCH_CRON,
    identifier: 'fx-fetch-daily',
    // payload 不要 (タスク本体は env FX_RATE_API_URL を内部で読む)
  },
  {
    task: CATALOG_FETCH_TASK_NAME,
    match: resolveCatalogFetchCron(),
    identifier: 'catalog-fetch-daily',
    payload: { trigger: 'cron' },
  },
  {
    task: BATCH_PLAN_DISPATCHER_TASK_NAME,
    match: BATCH_PLAN_DISPATCHER_CRON,
    identifier: 'batch-plan-dispatcher-minute',
    // payload 不要 (タスク本体は now() を内部で取り DB 駆動で plan を探す)
  },
  // SP-07 T-07-02: 毎時 0 分に monthly scope コストチェック (docs/05 §5.4)
  {
    task: ALERT_COST_CHECK_TASK_NAME,
    match: ALERT_COST_CHECK_CRON,
    identifier: 'alert-cost-check-hourly',
    payload: { scope: 'monthly' },
  },
  // T-09-04: 週次ジョブログアーカイブ (日曜 03:00 JST = 土曜 18:00 UTC, docs/05 §5.3.18)
  {
    task: ARCHIVE_JOBS_TASK_NAME,
    match: ARCHIVE_JOBS_CRON,
    identifier: 'archive-jobs-weekly',
  },
  // sales.fetch.dispatch は AppSettings.sales_auto_fetch_enabled に応じて
  // buildCronItemsWithSettings() で条件付き追加する (SP-12 T-12-05)。
  // 静的 CRON_ITEMS には含めない — 既存テストの 6 件アサーションを維持するため。
];

/** graphile-worker `run({ parsedCronItems })` に渡す。空配列なら cron 無効。 */
export function buildParsedCronItems(items: CronItem[] = CRON_ITEMS): ParsedCronItem[] {
  return parseCronItems(items);
}
