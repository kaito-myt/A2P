/**
 * Runtime verification spec for T-03-06 — `generateThemes` SA + `pipeline.theme.generate`
 * worker タスク (F-001).
 *
 * SP-03 段階では `/themes` 画面 (S-002) は配線済だが、E2E ブラウザ操作経由で
 * Marketer (claude-opus-4-7 + web_search) を流すには Cookie 認証 + Next.js SA POST +
 * graphile-worker 実起動が必要で、テストランタイムからの「単発呼出 → DB 観測」より
 * 観測点が多くノイズが入る。よって以下を Node ランタイム上で直接呼び出して検証する:
 *
 *   1. 一時 Account (status='archived') を作成
 *   2. `generateThemesCore` を実 prisma + spy enqueueJob で実行:
 *      - result.ok === true / session_id (cuid) + job_id (cuid) 取得
 *      - Job 行が `kind='pipeline.theme.generate'`, `status='queued'`, payload に
 *        全生成パラメタが含まれること
 *      - audit_log 行が `theme_session.generate` で INSERT されていること
 *      - enqueueJob spy が `pipeline.theme.generate` + payload `{ theme_session_id, job_id }`
 *        で 1 回呼ばれること
 *   3. `runPipelineThemeGenerate({ theme_session_id, job_id })` を実 LLM + 実 DB で実行:
 *      - Job: queued → running → done、result_json.candidate_count === 3
 *      - ThemeCandidate: 3 行 INSERT、各行 title/hook/genre/competitors_json/signals_json 存在
 *      - token_usage: role='marketer', provider='anthropic', theme_session_id 紐付け、
 *        input_tokens > 100, output_tokens > 0
 *   4. クリーンアップ: TokenUsage / ThemeCandidate / AuditLog / Job / Account を deleteMany
 *
 * 注: 本 spec は `page` を使わない (UI 観測ではなく内部 SA/worker の契約検証)。
 *     Playwright を test runner として借用し、apps/web/lib/themes-core.ts と
 *     apps/worker/src/tasks/pipeline-theme-generate.ts を直接 import する。
 *     セットアップ済みの Postgres (Docker `a2p-pg` port 5433) と
 *     .env.local (ANTHROPIC_API_KEY 実値あり) が前提。
 *     ModelAssignment (marketer, anthropic, claude-opus-4-7) + Prompt
 *     (role='marketer', genre=null active) が seed 済であることも前提。
 *
 * コスト: claude-opus-4-7 + web_search 1 呼出 ≒ $0.10-0.20 / run (~15-30 円)
 *         CI ではスキップ可 (PLAYWRIGHT_SKIP_REAL_API=1)
 */
import { test, expect } from '@playwright/test';

import { prisma, Prisma } from '@a2p/db';
import { invalidateApiKeyCache } from '@a2p/agents/lib/get-api-key';

import {
  generateThemesCore,
  PIPELINE_THEME_GENERATE_TASK_NAME,
  type ThemesDeps,
} from '../../apps/web/lib/themes-core.js';
import {
  runPipelineThemeGenerate,
} from '../../apps/worker/src/tasks/pipeline-theme-generate.js';

const SKIP_REAL_API = process.env.PLAYWRIGHT_SKIP_REAL_API === '1';

test.describe('runtime: generateThemes SA + pipeline.theme.generate worker (T-03-06)', () => {
  // SA + claude-opus-4-7 + web_search + DB I/O で 60-300s 程度想定
  test.setTimeout(360_000);

  let accountId: string;
  let actorUserId: string;
  let themeSessionId: string;
  let internalJobId: string;
  let enqueueJobSpy: {
    calls: Array<{ taskName: string; payload: unknown }>;
  };

  test.beforeAll(async () => {
    if (SKIP_REAL_API) return;
    invalidateApiKeyCache();

    // 一時 User (audit_log.actor_id FK 用)
    const username = `e2e-themes-op-${Date.now()}`;
    const user = await prisma.user.create({
      data: {
        username,
        // ダミー bcrypt ハッシュ (ログインには使わない、FK 用 placeholder)
        password_hash: '$2a$10$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    });
    actorUserId = user.id;

    // 一時 Account (status='archived' でダッシュボードに出さない)
    const account = await prisma.account.create({
      data: {
        pen_name: `e2e-themes-${Date.now()}`,
        genre_policy_json: {
          primary_genre: 'business',
          ratio: { business: 1 },
          focus_themes: ['remote_work'],
        },
        status: 'archived',
      },
    });
    accountId = account.id;
  });

  test.afterAll(async () => {
    if (SKIP_REAL_API) return;

    // 順序: token_usage → theme_candidates → audit_log → Job → Account
    if (themeSessionId) {
      await prisma.tokenUsage
        .deleteMany({ where: { theme_session_id: themeSessionId } })
        .catch(() => undefined);
      await prisma.themeCandidate
        .deleteMany({ where: { theme_session_id: themeSessionId } })
        .catch(() => undefined);
      await prisma.auditLog
        .deleteMany({
          where: { target_kind: 'theme_session', target_id: themeSessionId },
        })
        .catch(() => undefined);
    }
    if (internalJobId) {
      // 念のため job 紐付け token_usage も掃除
      await prisma.tokenUsage
        .deleteMany({ where: { job_id: internalJobId } })
        .catch(() => undefined);
      await prisma.job
        .delete({ where: { id: internalJobId } })
        .catch(() => undefined);
    }
    if (accountId) {
      // ThemeCandidate は account cascade で消えるが、明示削除済なので no-op
      await prisma.account
        .delete({ where: { id: accountId } })
        .catch(() => undefined);
    }
    if (actorUserId) {
      await prisma.user
        .delete({ where: { id: actorUserId } })
        .catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  test('generateThemesCore → Job INSERT + enqueue + audit_log', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // enqueueJob を spy にして payload 観測
    enqueueJobSpy = { calls: [] };
    const enqueueJob = async (taskName: string, payload: unknown) => {
      enqueueJobSpy.calls.push({ taskName, payload });
      return `mock_graphile_${enqueueJobSpy.calls.length}`;
    };

    const deps: ThemesDeps = {
      accountRepo: prisma.account,
      jobRepo: prisma.job,
      auditLogRepo: prisma.auditLog,
      session: { user: { id: actorUserId, username: 'operator' } },
      enqueueJob,
    };

    const result = await generateThemesCore(
      {
        accountId,
        genre: 'business',
        keywordOrBrief: 'リモートワーク時代のチームマネジメント',
        count: 3, // コスト抑制
      },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`generateThemesCore failed: ${JSON.stringify(result)}`);
    }
    expect(typeof result.data.session_id).toBe('string');
    expect(typeof result.data.job_id).toBe('string');
    expect(result.data.session_id.length).toBeGreaterThan(0);
    expect(result.data.job_id.length).toBeGreaterThan(0);

    themeSessionId = result.data.session_id;
    internalJobId = result.data.job_id;

    // --- Job 行検証 -------------------------------------------------------
    const job = await prisma.job.findUnique({ where: { id: internalJobId } });
    expect(job).not.toBeNull();
    expect(job!.kind).toBe(PIPELINE_THEME_GENERATE_TASK_NAME);
    expect(job!.kind).toBe('pipeline.theme.generate');
    expect(job!.status).toBe('queued');
    expect(job!.book_id).toBeNull();
    expect(job!.parent_job_id).toBeNull();
    const payload = job!.payload_json as Record<string, unknown>;
    expect(payload.theme_session_id).toBe(themeSessionId);
    expect(payload.account_id).toBe(accountId);
    expect(payload.genre).toBe('business');
    expect(payload.keyword_or_brief).toBe(
      'リモートワーク時代のチームマネジメント',
    );
    expect(payload.count).toBe(3);

    // --- enqueueJob spy 検証 ---------------------------------------------
    expect(enqueueJobSpy.calls).toHaveLength(1);
    expect(enqueueJobSpy.calls[0]!.taskName).toBe(
      'pipeline.theme.generate',
    );
    const enqPayload = enqueueJobSpy.calls[0]!.payload as Record<string, unknown>;
    expect(enqPayload.theme_session_id).toBe(themeSessionId);
    expect(enqPayload.job_id).toBe(internalJobId);

    // --- audit_log 行検証 -------------------------------------------------
    const auditRows = await prisma.auditLog.findMany({
      where: { target_kind: 'theme_session', target_id: themeSessionId },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe('theme_session.generate');
    expect(auditRows[0]!.actor_id).toBe(actorUserId);
  });

  test('runPipelineThemeGenerate → Job done + ThemeCandidate 3 行 + token_usage 1 行', async () => {
    test.skip(SKIP_REAL_API, 'PLAYWRIGHT_SKIP_REAL_API=1 — 実 API 呼出スキップ');

    // 前テストの状態に依存 (Playwright project では同一 worker で順次実行される前提)。
    expect(themeSessionId).toBeTruthy();
    expect(internalJobId).toBeTruthy();

    // 事前: token_usage / theme_candidates いずれも空
    const beforeUsage = await prisma.tokenUsage.count({
      where: { theme_session_id: themeSessionId },
    });
    expect(beforeUsage).toBe(0);
    const beforeCandidates = await prisma.themeCandidate.count({
      where: { theme_session_id: themeSessionId },
    });
    expect(beforeCandidates).toBe(0);

    // --- 実呼出 (実 LLM + 実 DB) -----------------------------------------
    // Marketer の LLM 出力は stochastic で、稀に JSON 抽出に失敗する
    // (marketer.theme.invalid_output: failed to parse JSON)。これは T-03-01 の
    // Marketer 側起因の既知 flake で、T-03-06 worker 統合の検証範囲外。
    // 安定性確保のため最大 3 回まで retry — 各 retry の前に前回失敗で残った
    // token_usage / theme_candidates を掃除し、Job を queued に巻き戻す。
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        await runPipelineThemeGenerate({
          theme_session_id: themeSessionId,
          job_id: internalJobId,
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(
          `[T-03-06 runtime] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`,
        );
        // デバッグ: AgentError は details.rawText を持つことがあるので最初の attempt のみログ
        if (attempt === 1 && err && typeof err === 'object' && 'details' in err) {
          const details = (err as { details?: unknown }).details;
          // eslint-disable-next-line no-console
          console.warn(
            `[T-03-06 runtime] attempt 1 details: ${JSON.stringify(details).slice(0, 2000)}`,
          );
        }
        if (attempt === MAX_ATTEMPTS) break;
        // 前回失敗の残骸を掃除して再投入準備
        await prisma.tokenUsage.deleteMany({
          where: { theme_session_id: themeSessionId },
        });
        await prisma.themeCandidate.deleteMany({
          where: { theme_session_id: themeSessionId },
        });
        await prisma.job.update({
          where: { id: internalJobId },
          data: {
            status: 'queued',
            started_at: null,
            finished_at: null,
            error: null,
            result_json: Prisma.JsonNull,
          },
        });
      }
    }
    if (lastErr) throw lastErr;

    // --- Job: queued → running → done ------------------------------------
    const finalJob = await prisma.job.findUnique({ where: { id: internalJobId } });
    expect(finalJob).not.toBeNull();
    expect(finalJob!.status).toBe('done');
    expect(finalJob!.started_at).not.toBeNull();
    expect(finalJob!.finished_at).not.toBeNull();
    expect(finalJob!.error).toBeNull();
    const resultJson = finalJob!.result_json as Record<string, unknown>;
    expect(resultJson.theme_session_id).toBe(themeSessionId);
    expect(resultJson.candidate_count).toBe(3);

    // --- ThemeCandidate 3 行 INSERT --------------------------------------
    const candidates = await prisma.themeCandidate.findMany({
      where: { theme_session_id: themeSessionId },
    });
    expect(candidates).toHaveLength(3);
    for (const c of candidates) {
      expect(c.account_id).toBe(accountId);
      expect(c.genre).toBe('business');
      expect(c.status).toBe('pending');
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.title.length).toBeLessThanOrEqual(200);
      expect(c.hook.length).toBeGreaterThan(0);
      // target_reader は optional だが Marketer は基本埋める
      expect(c.competitors_json).toBeDefined();
      expect(c.signals_json).toBeDefined();
      // signals_json の必須キー存在 (Marketer 出力 schema 由来)
      const signals = c.signals_json as Record<string, unknown>;
      expect(typeof signals.reasoning).toBe('string');
      expect(typeof signals.market_score).toBe('number');
      expect(typeof signals.predicted_chapters).toBe('number');
    }

    // title 一意性 (Marketer 重複除外ロジック)
    const titles = candidates.map((c) => c.title);
    const uniq = new Set(titles.map((t) => t.normalize('NFKC').trim().toLowerCase()));
    expect(uniq.size).toBe(titles.length);

    // --- token_usage: role='marketer' 1 行 -------------------------------
    const usageRows = await prisma.tokenUsage.findMany({
      where: { theme_session_id: themeSessionId },
    });
    expect(usageRows).toHaveLength(1);
    const usage = usageRows[0]!;
    expect(usage.provider).toBe('anthropic');
    expect(usage.role).toBe('marketer');
    expect(usage.theme_session_id).toBe(themeSessionId);
    expect(usage.job_id).toBe(internalJobId);
    expect(usage.book_id).toBeNull();
    expect(usage.model).toBe('claude-opus-4-7');
    expect(usage.input_tokens).toBeGreaterThan(100);
    expect(usage.output_tokens).toBeGreaterThan(0);
    expect(usage.image_count).toBe(0);

    // eslint-disable-next-line no-console
    console.log(
      `[T-03-06 runtime] candidates=${candidates.length} ` +
        `tokens in=${usage.input_tokens} out=${usage.output_tokens} ` +
        `cost_jpy=${usage.cost_jpy.toString()}`,
    );
  });
});
