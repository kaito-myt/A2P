/**
 * メールテンプレ内で共通利用する日本語文言。
 * 全テンプレが本ファイルから import する（コンポーネント内ハードコーディング禁止）。
 *
 * 文言の正本化に伴い、後続スプリント (SP-06 修正コメント / SP-07 コストアラート /
 * SP-02 単価変動) で文言調整する場合も、本ファイルのみを編集する想定。
 */

export const COMMON = {
  appName: 'A2P',
  footerSignature: '— A2P (Amazon Automated Publishing Tool)',
  ctaOpenDashboard: 'ダッシュボードを開く',
  ctaOpenBook: '書籍ページを開く',
  ctaOpenRevisionRun: '修正反映の結果を見る',
  ctaOpenCostPage: 'コストページを開く',
  ctaOpenModelCatalog: '単価カタログを開く',
} as const;

export const COST_EXCEEDED = {
  subject: (bookTitle: string) => `[A2P] 書籍コスト警告: ${bookTitle}`,
  heading: '書籍コスト警告',
  body: (args: { bookTitle: string; costJpy: number; limitJpy: number; status: 'warn' | 'paused' }) =>
    args.status === 'paused'
      ? `書籍「${args.bookTitle}」の累計コストが ${formatJpy(args.costJpy)} となり、停止閾値 ${formatJpy(args.limitJpy)} を超えました。\n` +
        `当該書籍は自動的に一時停止されました。進行中のジョブはキャンセルされています。\n` +
        `ダッシュボードから内容を確認し、手動で再開してください。`
      : `書籍「${args.bookTitle}」の累計コストが ${formatJpy(args.costJpy)} となり、警告閾値 ${formatJpy(args.limitJpy)} を超えました。\n` +
        `引き続き処理は継続しますが、コストが上昇した場合は自動停止されます。\n` +
        `ダッシュボードから内容を確認してください。`,
} as const;

export const MONTHLY_BUDGET_ALERT = {
  subject: (percentage: number) => `[A2P] 月次コスト予測アラート (${percentage}%)`,
  heading: '月次コスト予測アラート',
  body: (args: { month: string; usageJpy: number; predictedJpy: number; budgetJpy: number; ratio: number; elapsedDays: number; totalDays: number }) =>
    `${args.month} の月次コスト予測が予算の ${formatPercent(args.ratio)} に到達しました。\n` +
    `当月実績: ${formatJpy(args.usageJpy)}\n` +
    `月末予測: ${formatJpy(args.predictedJpy)} (${args.elapsedDays}日経過/${args.totalDays}日)\n` +
    `閾値: ${formatJpy(args.budgetJpy)}\n` +
    `必要に応じて、進行中の書籍生成を一時停止してください。`,
} as const;

export const PRICING_CHANGED = {
  subject: '[A2P] モデル単価が変動しました',
  heading: 'モデル単価が変動しました',
  body: (args: { model: string; oldUsdPerMtok: number; newUsdPerMtok: number; deltaPct: number }) =>
    `モデル「${args.model}」の単価が ${args.oldUsdPerMtok} USD/Mtok から ${args.newUsdPerMtok} USD/Mtok へ ${formatSignedPercent(args.deltaPct)} 変動しました。\n` +
    `単価カタログを開いて、必要に応じてモデル割当を見直してください。`,
} as const;

export const REVISION_RUN_COMPLETED = {
  subject: '[A2P] 修正コメントの一括反映が完了しました',
  heading: '修正コメントの一括反映が完了しました',
  body: (args: { bookTitle: string; appliedCount: number; skippedCount: number; failedCount: number }) =>
    `書籍「${args.bookTitle}」の修正反映が完了しました。\n` +
    `適用: ${args.appliedCount} 件 / スキップ: ${args.skippedCount} 件 / 失敗: ${args.failedCount} 件\n` +
    `差分レビュー画面から内容を確認してください。`,
} as const;

export const DB_BACKUP_FAILED = {
  subject: '[A2P] DB バックアップに失敗しました',
  heading: 'DB バックアップに失敗しました',
  body: (args: { occurredAt: string; reason: string; attempt: number; maxAttempts: number }) =>
    `週次の pg_dump → R2 退避ジョブ (archive.db.backup) が失敗しました。\n` +
    `発生時刻: ${args.occurredAt}\n` +
    `試行: ${args.attempt}/${args.maxAttempts}\n` +
    `原因: ${args.reason}\n` +
    `Railway / R2 / Postgres の稼働状況を確認のうえ、必要に応じて手動で再実行してください。`,
} as const;

export const JUDGE_NEEDS_REVIEW = {
  subject: (bookTitle: string) => `[A2P] 品質審査で要人間確認: ${bookTitle}`,
  heading: '品質審査が 3 回失敗しました — 手動確認が必要です',
  body: (args: { bookTitle: string; scoreTotal: number; retryCount: number }) =>
    `書籍「${args.bookTitle}」の品質スコアが ${args.scoreTotal} 点で、` +
    `${args.retryCount + 1} 回の再生成後も 80 点を達成できませんでした。\n` +
    `書籍ページから原稿内容を確認し、手動で修正コメントを追加するか、パイプラインを再起動してください。`,
  ctaLabel: '書籍ページを開く',
} as const;

// ---------------------------------------------------------------------------
// formatters
// ---------------------------------------------------------------------------

function formatJpy(value: number): string {
  return `${Math.round(value).toLocaleString('ja-JP')} 円`;
}

function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function formatSignedPercent(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}
