/**
 * DB 関連 E2E ヘルパ (T-02-14)
 *
 * - cleanupTransientData: User / AppSettings / Prompt / ModelAssignment は維持し、
 *   Book / Project / Job 等のテスト由来データのみ truncate する
 * - ensureSeededAuthUser: ログインで使うシードユーザーが存在しなければ
 *   .env.local の AUTH_USERNAME / AUTH_PASSWORD_HASH から upsert
 * - resetAuthLockout: 連続失敗ロック中の User をリセット (ロックアウト spec の cleanup 用)
 */
import { prisma } from '@a2p/db';

/**
 * E2E 開始前の DB クリーンアップ。
 *
 * 「テストが消してよい」具体表に絞る (User / AppSettings / Prompt /
 *  ModelAssignment / ModelCatalog は seed 由来なので保持)。
 *
 * 各テーブルは onDelete: Cascade が schema 側で定義されているため、
 * 親テーブル (Account / Book) を消せば子も自動削除される。
 *
 * SP-02 時点では Book / Account は seed されていない (= 常に空) ので、
 * 実質 no-op に近いが、SP-03 以降で UI から作られたデータをクリアする
 * 拡張点として用意しておく。
 */
export async function cleanupTransientData(): Promise<void> {
  // 順序: 子モデル → 親モデル (cascade 設定漏れの保険)
  // 参照しない場合は no-op で OK
  await prisma.$transaction([
    prisma.tokenUsage.deleteMany({}),
    prisma.job.deleteMany({}),
    prisma.book.deleteMany({}),
    prisma.themeCandidate.deleteMany({}),
    prisma.publishingPlan.deleteMany({}),
    prisma.account.deleteMany({}),
  ]);
}

/**
 * ログイン用シードユーザーが居なければ作る。既に居れば password_hash を
 * 設定値に揃えつつ failed_count / locked_until をリセットする (前回テストの副作用清掃)。
 *
 * パスワードハッシュは E2E_AUTH_PASSWORD_HASH を優先する。これは E2E ログインで
 * 平文 E2E_AUTH_PASSWORD を投入するため、その平文に対応する hash でシードする必要が
 * あるため。本番の AUTH_PASSWORD_HASH は運営者の実パスワード由来で E2E_AUTH_PASSWORD
 * とは一致しないことがあるので、E2E_AUTH_PASSWORD_HASH があればそちらを使う
 * (フォールバックは従来どおり AUTH_PASSWORD_HASH)。
 */
export async function ensureSeededAuthUser(): Promise<void> {
  const username = process.env.AUTH_USERNAME;
  const passwordHash =
    process.env.E2E_AUTH_PASSWORD_HASH ?? process.env.AUTH_PASSWORD_HASH;
  if (!username || !passwordHash) {
    throw new Error(
      '[e2e/db] AUTH_USERNAME / (E2E_AUTH_PASSWORD_HASH|AUTH_PASSWORD_HASH) が env に設定されていません',
    );
  }
  await prisma.user.upsert({
    where: { username },
    create: { username, password_hash: passwordHash },
    update: { failed_count: 0, locked_until: null, password_hash: passwordHash },
  });
}

/**
 * 指定ユーザーのロックアウト状態をリセットする。
 * ロックアウト spec 終了後に他テストへ影響を残さないため使う。
 */
export async function resetAuthLockout(username: string): Promise<void> {
  await prisma.user.updateMany({
    where: { username },
    data: { failed_count: 0, locked_until: null },
  });
}
