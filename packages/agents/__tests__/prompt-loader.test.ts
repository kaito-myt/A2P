import { describe, expect, it, vi } from 'vitest';

import { ConfigError } from '@a2p/contracts/errors';

// Prisma を引かないよう mock。各テストで PromptLoaderDeps 経由で repo を差し替える。
vi.mock('@a2p/db', () => ({
  prisma: { prompt: { findFirst: vi.fn() } },
}));

import { fillPlaceholders, loadActivePrompt } from '../src/lib/prompt-loader.js';

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

type PromptRow = {
  id: string;
  role: string;
  genre: string | null;
  version: number;
  body: string;
  status: 'active' | 'archived';
};

type SortOrder = 'asc' | 'desc';
type NullsOrder = 'first' | 'last';
type OrderBySpec = SortOrder | { sort: SortOrder; nulls?: NullsOrder };

/**
 * PostgreSQL の `ORDER BY` セマンティクスを正確に模した比較関数。
 *
 * WHY: 旧 mock は「DESC = NULLS LAST」を無条件に適用していたため、
 * 実装が `nulls: 'last'` 指定を忘れていてもバグ検知できなかった
 * (= 実 DB ランタイムで FAIL するのに unit test は PASS する罠)。
 *
 * 実 DB 挙動:
 *   - `ORDER BY x ASC` 既定 → NULLS LAST
 *   - `ORDER BY x DESC` 既定 → NULLS FIRST
 *   - `NULLS FIRST/LAST` 明示時はその通り
 */
function normalizeSpec(spec: OrderBySpec): { sort: SortOrder; nulls: NullsOrder } {
  if (typeof spec === 'string') {
    return { sort: spec, nulls: spec === 'desc' ? 'first' : 'last' };
  }
  return {
    sort: spec.sort,
    nulls: spec.nulls ?? (spec.sort === 'desc' ? 'first' : 'last'),
  };
}

function compareWithNulls(
  a: string | null,
  b: string | null,
  sort: SortOrder,
  nulls: NullsOrder,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return nulls === 'first' ? -1 : 1;
  if (b === null) return nulls === 'first' ? 1 : -1;
  if (a === b) return 0;
  const cmp = a < b ? -1 : 1;
  return sort === 'asc' ? cmp : -cmp;
}

/**
 * `OR: [{ genre }, { genre: null }]` + 任意の `orderBy` を擬似的に再現する。
 * orderBy の各エントリの NULLS 指定を実 DB 同等に解釈する。
 */
function makePromptRepo(rows: PromptRow[]) {
  return {
    prompt: {
      findFirst: vi.fn(
        async (args: {
          where: { role: string; status: string; OR: Array<{ genre: string | null }> };
          orderBy: Array<{ genre: OrderBySpec } | { version: OrderBySpec }>;
        }) => {
          const allowed = new Set(args.where.OR.map((o) => o.genre));
          const hits = rows.filter(
            (r) =>
              r.role === args.where.role &&
              r.status === args.where.status &&
              allowed.has(r.genre),
          );
          if (hits.length === 0) return null;

          hits.sort((a, b) => {
            for (const entry of args.orderBy) {
              if ('genre' in entry) {
                const { sort, nulls } = normalizeSpec(entry.genre);
                const c = compareWithNulls(a.genre, b.genre, sort, nulls);
                if (c !== 0) return c;
              } else {
                const { sort } = normalizeSpec(entry.version);
                if (a.version === b.version) continue;
                const c = a.version < b.version ? -1 : 1;
                return sort === 'asc' ? c : -c;
              }
            }
            return 0;
          });
          const r = hits[0]!;
          return { id: r.id, body: r.body, version: r.version, genre: r.genre };
        },
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// loadActivePrompt
// ---------------------------------------------------------------------------

describe('loadActivePrompt — genre 解決', () => {
  it('genre 指定あり: active 行を返す', async () => {
    const repo = makePromptRepo([
      {
        id: 'p-1',
        role: 'writer',
        genre: 'business',
        version: 1,
        body: 'business writer v1',
        status: 'active',
      },
      {
        id: 'p-2',
        role: 'writer',
        genre: null,
        version: 1,
        body: 'default writer v1',
        status: 'active',
      },
    ]);

    const result = await loadActivePrompt('writer', 'business', {
      prisma: repo,
    });

    expect(result.promptId).toBe('p-1');
    expect(result.template).toBe('business writer v1');
    expect(result.version).toBe(1);
    expect(result.genre).toBe('business');
  });

  it('genre null フォールバック: genre 指定 active が無ければ genre=null を返す', async () => {
    const repo = makePromptRepo([
      {
        id: 'p-default',
        role: 'judge',
        genre: null,
        version: 1,
        body: 'judge default',
        status: 'active',
      },
    ]);

    const result = await loadActivePrompt('judge', 'practical', {
      prisma: repo,
    });

    expect(result.promptId).toBe('p-default');
    expect(result.genre).toBeNull();
    expect(result.template).toBe('judge default');
  });

  it('genre 指定も genre=null も無ければ ConfigError', async () => {
    const repo = makePromptRepo([]);
    await expect(
      loadActivePrompt('writer', 'business', { prisma: repo }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('複数 version: 最新 active を返す (archived は無視)', async () => {
    const repo = makePromptRepo([
      {
        id: 'p-v1',
        role: 'writer',
        genre: null,
        version: 1,
        body: 'writer v1',
        status: 'archived',
      },
      {
        id: 'p-v2',
        role: 'writer',
        genre: null,
        version: 2,
        body: 'writer v2',
        status: 'active',
      },
    ]);

    const result = await loadActivePrompt('writer', null, { prisma: repo });

    expect(result.promptId).toBe('p-v2');
    expect(result.version).toBe(2);
    expect(result.template).toBe('writer v2');
  });

  // 回帰: 実 DB の PostgreSQL DESC 既定は NULLS FIRST。
  // 実装が `nulls: 'last'` を明示せず `orderBy: { genre: 'desc' }` だけだと
  // null fallback 行が先頭に並んで指定値が無視される (本 mock もそれを正確に再現)。
  it('回帰: genre 指定値と null 行が両方 active のとき、指定値が優先される', async () => {
    const repo = makePromptRepo([
      {
        id: 'p-default',
        role: 'marketer',
        genre: null,
        version: 9, // version は高いが genre 指定値が優先されるべき
        body: 'default marketer v9',
        status: 'active',
      },
      {
        id: 'p-practical',
        role: 'marketer',
        genre: 'practical',
        version: 1,
        body: 'practical marketer v1',
        status: 'active',
      },
    ]);

    const result = await loadActivePrompt('marketer', 'practical', { prisma: repo });
    expect(result.promptId).toBe('p-practical');
    expect(result.genre).toBe('practical');
  });

  it('回帰: 実装が orderBy で nulls: "last" を明示している (NULLS FIRST 既定では FAIL する)', async () => {
    // mock の findFirst 引数を直接検査し、genre orderBy spec が
    // `{ sort: 'desc', nulls: 'last' }` 形式で渡っていることを検証する。
    const repo = makePromptRepo([
      { id: 'x', role: 'writer', genre: 'business', version: 1, body: 'b', status: 'active' },
    ]);

    await loadActivePrompt('writer', 'business', { prisma: repo });

    const findFirstMock = repo.prompt.findFirst as unknown as {
      mock: { calls: unknown[][] };
    };
    const firstCallArgs = findFirstMock.mock.calls[0]![0] as {
      orderBy: Array<Record<string, unknown>>;
    };
    const genreEntry = firstCallArgs.orderBy.find(
      (o) => Object.prototype.hasOwnProperty.call(o, 'genre'),
    ) as { genre: { sort: string; nulls: string } } | undefined;
    expect(genreEntry).toBeDefined();
    expect(genreEntry!.genre).toEqual({ sort: 'desc', nulls: 'last' });
  });

  it('archived のみで active 無し → ConfigError (status filter が効く)', async () => {
    const repo = makePromptRepo([
      {
        id: 'p-old',
        role: 'editor',
        genre: null,
        version: 1,
        body: 'old',
        status: 'archived',
      },
    ]);
    await expect(
      loadActivePrompt('editor', null, { prisma: repo }),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// fillPlaceholders
// ---------------------------------------------------------------------------

describe('fillPlaceholders', () => {
  it('複数キーを差込', () => {
    const out = fillPlaceholders('Hello {name}, today is {day}', {
      name: 'World',
      day: 'Friday',
    });
    expect(out).toBe('Hello World, today is Friday');
  });

  it('data に無いキーはそのまま残り warn ログを出す', () => {
    const warn = vi.fn();
    const out = fillPlaceholders(
      'Hello {name}, age={age}',
      { name: 'World' },
      { logger: { warn } },
    );
    expect(out).toBe('Hello World, age={age}');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'unfilled placeholders',
      expect.objectContaining({ keys: ['age'] }),
    );
  });

  it('同一キーの複数出現: 全て置換', () => {
    const out = fillPlaceholders('{name}-{name}-{name}', { name: 'X' });
    expect(out).toBe('X-X-X');
  });

  it('空 template → 空文字 (warn なし)', () => {
    const warn = vi.fn();
    const out = fillPlaceholders('', {}, { logger: { warn } });
    expect(out).toBe('');
    expect(warn).not.toHaveBeenCalled();
  });

  it('数値 / 真偽値の値も String() で stringify される', () => {
    const out = fillPlaceholders('count={count}, enabled={enabled}', {
      count: 42,
      enabled: true,
    });
    expect(out).toBe('count=42, enabled=true');
  });

  it('1 パス置換のみ (差込値中の {x} は再評価しない)', () => {
    const warn = vi.fn();
    const out = fillPlaceholders(
      'A={a}, B={b}',
      { a: '{b}', b: 'BEE' },
      { logger: { warn } },
    );
    // a の値 "{b}" はそのまま挿入され、後続置換の対象にならない。
    expect(out).toBe('A={b}, B=BEE');
    // ただし最終文字列に {b} という未差込トークンが残るが、
    // これは差込値由来であり template スキャン時には missing 扱いされない。
    expect(warn).not.toHaveBeenCalled();
  });

  it('プレースホルダのないテンプレはそのまま返す', () => {
    const out = fillPlaceholders('plain string with { spaces } and braces.', {});
    // `{ spaces }` は内部に空白があるためマッチしない (key パターン制限)。
    expect(out).toBe('plain string with { spaces } and braces.');
  });
});

// ---------------------------------------------------------------------------
// ジャンル方針注入 (injectGenreTokens 経由 / loadActivePrompt が本文に差し込む)
// ---------------------------------------------------------------------------

describe('loadActivePrompt — {genre_guidance} 注入', () => {
  const bodyWithToken = '# writer\n\n{genre_guidance}\n\n## 出力\nJSON';

  function repoDefaultOnly() {
    return makePromptRepo([
      { id: 'p-def', role: 'writer', genre: null, version: 1, body: bodyWithToken, status: 'active' },
    ]);
  }

  it('既知 genre: そのジャンルの方針が注入される', async () => {
    const r = await loadActivePrompt('writer', 'money', { prisma: repoDefaultOnly() });
    // 既定(genre=null)本文を使いつつ、要求 genre=money の方針を注入する。
    expect(r.genre).toBeNull();
    expect(r.template).toContain('【ジャンル方針：投資・資産運用】');
    expect(r.template).not.toContain('{genre_guidance}');
  });

  it('genre=null: 汎用方針が注入される', async () => {
    const r = await loadActivePrompt('writer', null, { prisma: repoDefaultOnly() });
    expect(r.template).toContain('【ジャンル方針：汎用】');
    expect(r.template).not.toContain('{genre_guidance}');
  });

  it('未知 genre: ラベルは slug、方針は汎用にフォールバック', async () => {
    const r = await loadActivePrompt('writer', 'unknown_genre' as never, { prisma: repoDefaultOnly() });
    expect(r.template).toContain('【ジャンル方針：unknown_genre】');
  });

  it('トークンの無い本文は素通し (置換なし)', async () => {
    const repo = makePromptRepo([
      { id: 'p-x', role: 'editor', genre: null, version: 1, body: 'no tokens here', status: 'active' },
    ]);
    const r = await loadActivePrompt('editor', 'business', { prisma: repo });
    expect(r.template).toBe('no tokens here');
  });

  it('{genre_label} も注入される', async () => {
    const repo = makePromptRepo([
      { id: 'p-l', role: 'judge', genre: null, version: 1, body: 'ジャンル「{genre_label}」の読者', status: 'active' },
    ]);
    const r = await loadActivePrompt('judge', 'history', { prisma: repo });
    expect(r.template).toBe('ジャンル「歴史・教養」の読者');
  });
});
