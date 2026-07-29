#!/usr/bin/env node
/**
 * KDP 自宅プロキシ オーケストレータ [F-038 補強 / 住宅IP経由アクセス]。
 *
 * 運営者の自宅PC(住宅IP)で常駐し、Railway の worker が KDP へアクセスする際の
 * 「出口」を住宅IPにするための踏み台。3 つを面倒みる:
 *   1) 認証付き HTTP プロキシ (CONNECT トンネル) を 127.0.0.1:PORT に立てる
 *   2) `ngrok tcp PORT` でそのプロキシをインターネットに公開する
 *   3) ngrok の公開アドレス(host:port)を prod DB(app_settings.kdp_proxy_url)へ
 *      heartbeat 公開する。worker はこれを Playwright の HTTP プロキシとして使う。
 *
 * これにより Railway のデータセンター IP ではなく自宅の住宅 IP から Amazon にアクセスでき、
 * ログイン時の anti-bot(CAPTCHA/停滞)を回避する。
 *
 * 停止(Ctrl+C)すると DB の kdp_proxy_enabled を false に戻すので、worker は自動で
 * 直結(従来動作)にフォールバックする。heartbeat が 5 分途切れても worker 側で失効判定する。
 *
 * 認証情報は DB に置かない。ユーザ/パスは env (KDP_PROXY_USER / KDP_PROXY_PASS)。
 *
 * 使い方:
 *   1) scripts/.kdp-proxy.env を用意 (scripts/.kdp-proxy.env.example 参照)
 *   2) ngrok を入れて認証: winget install ngrok.ngrok && ngrok config add-authtoken <token>
 *   3) node scripts/kdp-home-proxy.mjs   ← 自宅作業中は起動しっぱなしにする
 */
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

// --------------------------------------------------------------------------
// 設定ロード
// --------------------------------------------------------------------------
function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile(path.join(__dirname, '.kdp-proxy.env'));
loadEnvFile(path.join(repoRoot, '.env.local'));

const DB_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const USER = process.env.KDP_PROXY_USER;
const PASS = process.env.KDP_PROXY_PASS;
const PORT = Number(process.env.KDP_PROXY_LOCAL_PORT || 8899);
const NGROK = process.env.NGROK_PATH || 'ngrok';
const HEARTBEAT_MS = 60_000;

if (!DB_URL || !USER || !PASS) {
  console.error(
    '[config] 必須設定が不足しています。scripts/.kdp-proxy.env に以下を設定してください:\n' +
      '  DATABASE_PUBLIC_URL=postgres://...  (Railway の公開DB URL)\n' +
      '  KDP_PROXY_USER=...  (Railway 側 env と一致させる)\n' +
      '  KDP_PROXY_PASS=...  (同上)\n' +
      'ひな型: scripts/.kdp-proxy.env.example',
  );
  process.exit(1);
}

// --------------------------------------------------------------------------
// pg ロード (monorepo の node_modules から解決)
// --------------------------------------------------------------------------
function loadPg() {
  const bases = [
    import.meta.url,
    path.join(repoRoot, 'packages', 'db', 'package.json'),
    path.join(repoRoot, 'package.json'),
  ];
  for (const b of bases) {
    try {
      return createRequire(b)('pg');
    } catch {
      /* try next */
    }
  }
  throw new Error('pg モジュールが見つかりません (pnpm install 済みか確認してください)');
}
const { Client } = loadPg();

async function withDb(fn) {
  const c = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => {});
  }
}
async function publishAddr(hostPort) {
  await withDb((c) =>
    c.query(
      `update app_settings set kdp_proxy_url=$1, kdp_proxy_enabled=true, kdp_proxy_updated_at=now() where id='singleton'`,
      [hostPort],
    ),
  );
}
async function disableProxy() {
  await withDb((c) =>
    c.query(`update app_settings set kdp_proxy_enabled=false, kdp_proxy_updated_at=now() where id='singleton'`),
  );
}

// --------------------------------------------------------------------------
// 認証付き HTTP プロキシ (CONNECT トンネル)
// --------------------------------------------------------------------------
const EXPECTED_AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
function authOk(header) {
  if (typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(EXPECTED_AUTH);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const proxy = http.createServer((req, res) => {
  // 平文 HTTP プロキシ (Amazon は基本 HTTPS なので稀。念のため対応)。
  if (!authOk(req.headers['proxy-authorization'])) {
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="kdp"' });
    res.end();
    return;
  }
  try {
    const u = new URL(req.url);
    const upstream = http.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers: req.headers },
      (pr) => {
        res.writeHead(pr.statusCode || 502, pr.headers);
        pr.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  } catch {
    res.writeHead(400);
    res.end();
  }
});

proxy.on('connect', (req, clientSocket, head) => {
  if (!authOk(req.headers['proxy-authorization'])) {
    clientSocket.write(
      'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="kdp"\r\nConnection: close\r\n\r\n',
    );
    clientSocket.end();
    return;
  }
  const [host, portStr] = req.url.split(':');
  const port = Number(portStr) || 443;
  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => {
    try {
      clientSocket.end();
    } catch {
      /* noop */
    }
  });
  clientSocket.on('error', () => {
    try {
      upstream.end();
    } catch {
      /* noop */
    }
  });
});

proxy.on('error', (err) => {
  console.error(`[proxy] error: ${err.message}`);
  if (err.code === 'EADDRINUSE') {
    console.error(`[proxy] ポート ${PORT} が使用中です。KDP_PROXY_LOCAL_PORT を変えてください。`);
    process.exit(1);
  }
});
proxy.listen(PORT, '127.0.0.1', () => console.log(`[proxy] 127.0.0.1:${PORT} で待受開始 (認証付き CONNECT トンネル)`));

// --------------------------------------------------------------------------
// ngrok 起動
// --------------------------------------------------------------------------
const ngrok = spawn(NGROK, ['tcp', String(PORT), '--log', 'stdout'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
ngrok.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error(
      '[ngrok] ngrok が見つかりません。導入してください:\n' +
        '  winget install ngrok.ngrok\n' +
        '  ngrok config add-authtoken <あなたのトークン>   (https://dashboard.ngrok.com で取得)',
    );
    process.exit(1);
  }
  console.error(`[ngrok] spawn error: ${err.message}`);
});
ngrok.stdout.on('data', (d) => {
  const s = String(d);
  if (/err|error|fail/i.test(s)) process.stderr.write('[ngrok] ' + s);
});
ngrok.stderr.on('data', (d) => process.stderr.write('[ngrok] ' + d));

// --------------------------------------------------------------------------
// ngrok API からアドレス取得 → DB 公開 (heartbeat)
// --------------------------------------------------------------------------
function getTunnelAddr() {
  return new Promise((resolve) => {
    const r = http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(s);
          const t = (j.tunnels || []).find((x) => x.proto === 'tcp');
          resolve(t ? String(t.public_url) : null);
        } catch {
          resolve(null);
        }
      });
    });
    r.on('error', () => resolve(null));
    r.setTimeout(4000, () => {
      r.destroy();
      resolve(null);
    });
  });
}

let currentAddr = null;
let firstPublished = false;
async function tick() {
  const url = await getTunnelAddr();
  if (!url) {
    if (!firstPublished) console.log('[ngrok] トンネル確立待ち...');
    return;
  }
  const hostPort = url.replace(/^tcp:\/\//, '');
  if (hostPort !== currentAddr) {
    currentAddr = hostPort;
    console.log(`[tunnel] 公開アドレス: ${hostPort}`);
  }
  try {
    await publishAddr(hostPort);
    if (!firstPublished) {
      firstPublished = true;
      console.log(`[db] proxy 有効化 & アドレス公開 (worker が住宅IP経由に切替わります)`);
    }
  } catch (e) {
    console.error(`[db] 公開失敗: ${e.message}`);
  }
}

// 起動直後はアドレス確立まで短間隔、確立後は heartbeat 間隔。
const boot = setInterval(async () => {
  if (firstPublished) {
    clearInterval(boot);
    return;
  }
  await tick();
}, 3000);
setInterval(tick, HEARTBEAT_MS);

// --------------------------------------------------------------------------
// 終了処理
// --------------------------------------------------------------------------
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[shutdown] proxy を DB で無効化して終了します (worker は直結にフォールバック)...');
  await disableProxy().catch((e) => console.error(`[shutdown] disable 失敗: ${e.message}`));
  try {
    ngrok.kill();
  } catch {
    /* noop */
  }
  try {
    proxy.close();
  } catch {
    /* noop */
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log(
  `[ready] KDP 自宅プロキシ起動中。認証ユーザ=${USER.slice(0, 3)}*** / ローカルポート=${PORT}\n` +
    '        このウィンドウは開いたままにしてください。Ctrl+C で停止すると worker は直結に戻ります。',
);
