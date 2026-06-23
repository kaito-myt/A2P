#!/usr/bin/env node
/**
 * E2E パイプライン検証ドライバ (loop-engineering 資産)。
 *
 * 目的: 本番 (または任意の) DB に対し、テーマ選定後の 1 冊を
 *   アウトライン承認 → 本文執筆 → 校閲 → サムネ生成
 * まで実際に流し、各段の DB 遷移を機械的に検証する。
 *
 * これは「メーカー(承認して走らせる) / チェッカー(ポーリングで遷移を検証)」を
 * 分離した小さな検証ループ。worker は graphile-worker のキューを消化して
 * 自律的に次段を enqueue するため、本スクリプトは投入と観測だけを担う。
 *
 * 使い方 (DATABASE_URL を環境変数で渡す):
 *   node scripts/e2e-pipeline.cjs approve "<書名の一部>"   # アウトライン承認 + dispatch enqueue
 *   node scripts/e2e-pipeline.cjs watch   "<書名の一部>"   # 5 秒間隔で段階遷移を表示
 *   node scripts/e2e-pipeline.cjs status                    # 全書籍の現在状態サマリ
 *   node scripts/e2e-pipeline.cjs run    "<書名の一部>"     # approve してから watch まで一気通貫
 *
 * pg はワークスペース hoist 先から解決する (リポジトリルートから実行する想定)。
 */
const path = require('node:path');

function loadPg() {
  // ルート node_modules に pg が無い (pnpm) ため .pnpm から絶対解決する。
  const candidates = [
    'pg',
    path.join(process.cwd(), 'node_modules/.pnpm/pg@8.21.0/node_modules/pg'),
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* try next */
    }
  }
  throw new Error('pg module not found. リポジトリルートから実行してください。');
}

const { Client } = loadPg();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL env が未設定です。');
  process.exit(1);
}

/** Prisma 互換の cuid 風 id を雑に生成 (text PK なので一意であればよい)。 */
function genId(prefix) {
  let s = prefix;
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 20; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function withClient(fn) {
  const c = new Client({ connectionString: DATABASE_URL, ssl: false });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function findBook(c, substr) {
  const r = await c.query(
    `select id, title, status from books where title ilike $1 order by created_at desc limit 1`,
    [`%${substr}%`],
  );
  if (r.rows.length === 0) throw new Error(`書籍が見つかりません: "${substr}"`);
  return r.rows[0];
}

async function snapshot(c, bookId) {
  const book = (await c.query(`select status from books where id=$1`, [bookId])).rows[0];
  const outline = (
    await c.query(`select status from outlines where book_id=$1`, [bookId])
  ).rows[0];
  const ch = (
    await c.query(
      `select count(*)::int total, count(*) filter (where status='done')::int done,
              count(*) filter (where status='failed')::int failed,
              coalesce(sum(char_count),0)::int chars
       from chapters where book_id=$1`,
      [bookId],
    )
  ).rows[0];
  const covers = (
    await c.query(`select count(*)::int n from covers where book_id=$1`, [bookId])
  ).rows[0];
  const ct = (
    await c.query(`select count(*)::int n from cover_text_proposals where book_id=$1`, [bookId])
  ).rows[0];
  const jobs = (
    await c.query(
      `select kind, status, count(*)::int n from jobs where book_id=$1 group by kind,status`,
      [bookId],
    )
  ).rows;
  const failedJobs = (
    await c.query(
      `select kind, error from jobs where book_id=$1 and status='failed' order by created_at desc limit 5`,
      [bookId],
    )
  ).rows;
  return {
    book: book?.status,
    outline: outline?.status,
    chapters: `${ch.done}/${ch.total} done${ch.failed ? ` (${ch.failed} failed)` : ''}`,
    chars: ch.chars,
    coverTexts: ct.n,
    covers: covers.n,
    jobs,
    failedJobs,
  };
}

function printSnap(label, s) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(
    `[${ts}] ${label} book=${s.book} outline=${s.outline} chapters=${s.chapters} chars=${s.chars} coverTexts=${s.coverTexts} covers=${s.covers}`,
  );
  if (s.failedJobs && s.failedJobs.length) {
    for (const f of s.failedJobs) {
      console.log(`        FAILED ${f.kind}: ${String(f.error || '').slice(0, 160)}`);
    }
  }
}

async function approve(substr) {
  await withClient(async (c) => {
    const book = await findBook(c, substr);
    console.log(`対象: ${book.title} (${book.id}) status=${book.status}`);
    const o = (
      await c.query(`select id, status from outlines where book_id=$1`, [book.id])
    ).rows[0];
    if (!o) throw new Error('outline がありません (先に outline 生成が必要)');
    if (o.status !== 'pending_review' && o.status !== 'approved') {
      throw new Error(`outline.status=${o.status} は承認対象外です`);
    }
    if (o.status === 'approved') {
      console.log('outline は既に approved。dispatch のみ再投入します。');
    }

    const jobId = genId('c');
    const payload = { book_id: book.id, job_id: jobId, outline_id: o.id };

    await c.query('begin');
    await c.query(
      `update outlines set status='approved', approved_at=now(), updated_at=now() where id=$1`,
      [o.id],
    );
    await c.query(`update books set status='running', updated_at=now() where id=$1`, [book.id]);
    await c.query(
      `insert into jobs (id, kind, book_id, status, payload_json, created_at)
       values ($1,'pipeline.book.writer.chapters.dispatch',$2,'queued',$3, now())`,
      [jobId, book.id, JSON.stringify(payload)],
    );
    await c.query(
      `insert into audit_log (id, actor_id, action, target_kind, target_id, before_json, after_json, created_at)
       values ($1, NULL, 'outlines.bulk_approve','outline','bulk',$2,$3, now())`,
      [
        genId('a'),
        JSON.stringify({ outline_ids: [o.id], previous_status: o.status }),
        JSON.stringify({ outline_ids: [o.id], approved_count: 1, via: 'e2e-pipeline.cjs' }),
      ],
    );
    await c.query(
      `select graphile_worker.add_job('pipeline.book.writer.chapters.dispatch', $1::json)`,
      [JSON.stringify(payload)],
    );
    await c.query('commit');
    console.log(`承認 + dispatch enqueue 完了 (job_id=${jobId})`);
  });
}

async function watch(substr, maxMin = 45) {
  const deadline = Date.now() + maxMin * 60_000;
  let bookId;
  await withClient(async (c) => {
    bookId = (await findBook(c, substr)).id;
  });
  let last = '';
  while (Date.now() < deadline) {
    const s = await withClient((c) => snapshot(c, bookId));
    const key = JSON.stringify([s.book, s.outline, s.chapters, s.coverTexts, s.covers]);
    if (key !== last) {
      printSnap('watch', s);
      last = key;
    }
    // 成功条件: サムネ画像が出揃った (covers>=3) もしくは judging/done/thumbnail 到達
    if (s.covers >= 3 || ['thumbnail', 'judging', 'exporting', 'done'].includes(s.book)) {
      printSnap('DONE ', s);
      console.log('✅ サムネ生成まで到達しました。');
      return;
    }
    if (s.failedJobs && s.failedJobs.length) {
      // 致命でないリトライもあるので即終了はせず通知のみ (printSnap 済み)
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  console.log('⏱ タイムアウト (時間内に完了せず)。最新状態:');
  const s = await withClient((c) => snapshot(c, bookId));
  printSnap('final', s);
}

async function status() {
  await withClient(async (c) => {
    const b = await c.query(
      `select b.id, b.title, b.status,
              (select status from outlines o where o.book_id=b.id) outline,
              (select count(*) from chapters ch where ch.book_id=b.id)::int chapters,
              (select count(*) from covers cv where cv.book_id=b.id)::int covers
       from books b order by b.created_at desc`,
    );
    b.rows.forEach((r) =>
      console.log(
        `${String(r.status).padEnd(12)} outline=${String(r.outline || '-').padEnd(14)} ch=${String(r.chapters).padStart(2)} cov=${r.covers}  ${(r.title || '').slice(0, 34)}`,
      ),
    );
  });
}

(async () => {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'approve':
      await approve(arg);
      break;
    case 'watch':
      await watch(arg);
      break;
    case 'run':
      await approve(arg);
      await watch(arg);
      break;
    case 'status':
      await status();
      break;
    default:
      console.log('usage: e2e-pipeline.cjs <approve|watch|run|status> [book-title-substr]');
      process.exit(1);
  }
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
