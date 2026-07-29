/**
 * KDP 自宅プロキシ解決 [F-038 補強 / 住宅IP経由アクセス]。
 *
 * Railway のデータセンター IP だと Amazon ログインが anti-bot(CAPTCHA/停滞)に当たるため、
 * 運営者の自宅PCで動くオーケストレータ(`scripts/kdp-home-proxy.mjs`)が ngrok の公開
 * アドレス(host:port)を `app_settings.kdp_proxy_url` に heartbeat 公開する。worker は
 * それを Playwright の HTTP プロキシとして使い、KDP へのアクセスを住宅IPから出す。
 *
 * - 認証情報(ユーザ/パス)は DB に置かず env(`KDP_PROXY_USER`/`KDP_PROXY_PASS`)から取る。
 *   DB に載るのは ephemeral な ngrok アドレスのみ(漏れても短命・要認証)。
 * - `kdp_proxy_updated_at` が古い(既定 5 分超)= トンネル停止とみなし null を返して直結に
 *   フォールバックする(死んだトンネルに繋いでハングするのを防ぐ)。
 */
import { createLogger } from '@a2p/contracts/logger';

const log = createLogger('worker.sales-fetch.kdp-proxy');

/** Playwright `launch({ proxy })` にそのまま渡せる形。 */
export interface KdpProxyConfig {
  /** 例: "http://1.tcp.ngrok.io:12345" */
  server: string;
  username?: string;
  password?: string;
}

/** heartbeat がこの ms より古ければトンネル停止とみなす。 */
export const PROXY_FRESH_MS = 5 * 60 * 1000;

/** `resolveKdpProxy` が必要とする最小 Prisma I/F(テストでモック可能)。 */
export interface KdpProxyPrisma {
  appSettings: {
    findUnique(args: {
      where: { id: string };
      select: {
        kdp_proxy_enabled: true;
        kdp_proxy_url: true;
        kdp_proxy_updated_at: true;
      };
    }): Promise<{
      kdp_proxy_enabled: boolean;
      kdp_proxy_url: string | null;
      kdp_proxy_updated_at: Date | null;
    } | null>;
  };
}

/**
 * app_settings から自宅プロキシ設定を解決する純ロジック。
 * 有効かつ url があり heartbeat が新しければ `KdpProxyConfig` を、そうでなければ null を返す。
 */
export async function resolveKdpProxy(
  db: KdpProxyPrisma,
  now: () => Date = () => new Date(),
): Promise<KdpProxyConfig | null> {
  let row;
  try {
    row = await db.appSettings.findUnique({
      where: { id: 'singleton' },
      select: { kdp_proxy_enabled: true, kdp_proxy_url: true, kdp_proxy_updated_at: true },
    });
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'failed to read proxy settings');
    return null;
  }

  if (!row || !row.kdp_proxy_enabled) return null;

  return buildProxyConfig(
    {
      url: row.kdp_proxy_url,
      updatedAt: row.kdp_proxy_updated_at,
      user: process.env.KDP_PROXY_USER,
      pass: process.env.KDP_PROXY_PASS,
    },
    now(),
  );
}

/**
 * 設定値から `KdpProxyConfig` を組み立てる純関数(テスト容易)。
 * url 欠落 / heartbeat 陳腐化 の場合は null。
 */
export function buildProxyConfig(
  input: { url: string | null; updatedAt: Date | null; user?: string; pass?: string },
  now: Date,
): KdpProxyConfig | null {
  const raw = (input.url ?? '').trim();
  if (!raw) return null;

  if (!input.updatedAt || now.getTime() - input.updatedAt.getTime() > PROXY_FRESH_MS) {
    log.warn(
      { updatedAt: input.updatedAt?.toISOString?.() ?? null },
      'kdp proxy heartbeat is stale — falling back to direct connection',
    );
    return null;
  }

  // 保存値は host:port を想定(スキーム/認証は含めない契約)。念のためスキーム除去。
  const hostPort = raw.replace(/^\w+:\/\//, '').replace(/\/+$/, '');
  const cfg: KdpProxyConfig = { server: `http://${hostPort}` };
  if (input.user) cfg.username = input.user;
  if (input.pass) cfg.password = input.pass;
  return cfg;
}
