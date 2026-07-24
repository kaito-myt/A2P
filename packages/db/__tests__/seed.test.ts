/**
 * seed.ts のユニットテスト。
 *
 * 実 DB なしで関数挙動を検証する：
 *  - buildAppSettingsSeed / buildPromptSeeds / buildModelAssignmentSeeds / buildUserSeed
 *    の戻り値が docs/05 §3 のスキーマ・docs/01 §7.3 の初期推奨表に整合
 *  - runSeed が prisma の各 model.* を期待回数だけ呼ぶ
 *  - 同じデータで 2 回 runSeed を呼んでも追加 create が発生しない (idempotent)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  PROMPT_ROLES,
  PROMPT_GENRES,
  PROMPT_GENRE_AXES,
  DEFAULT_AI_DISCLOSURE_TEXT,
  buildAppSettingsSeed,
  buildPromptSeeds,
  buildModelAssignmentSeeds,
  buildUserSeed,
  runSeed,
} from '../seed.js';

// ---------------------------------------------------------------------------
// Helpers — 最小 prisma モック
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string };

interface MockTable {
  rows: Row[];
  upsert: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
}

function makeTable(): MockTable {
  const rows: Row[] = [];
  let idCounter = 0;
  const nextId = () => `mock_${++idCounter}`;

  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const row = { id: nextId(), ...data } as Row;
    rows.push(row);
    return row;
  });

  const update = vi.fn(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const found = rows.find((r) => r.id === where.id);
      if (!found) throw new Error(`row not found: ${where.id}`);
      Object.assign(found, data);
      return found;
    },
  );

  const upsert = vi.fn(
    async ({
      where,
      create: createData,
      update: updateData,
    }: {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const found = rows.find((r) =>
        Object.entries(where).every(([k, v]) => r[k] === v),
      );
      if (found) {
        Object.assign(found, updateData);
        return found;
      }
      const row = { id: (createData.id as string) ?? nextId(), ...createData } as Row;
      rows.push(row);
      return row;
    },
  );

  const findFirst = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    return (
      rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null
    );
  });

  return { rows, upsert, create, update, findFirst };
}

function makePrismaMock() {
  return {
    appSettings: makeTable(),
    prompt: makeTable(),
    modelAssignment: makeTable(),
    user: makeTable(),
  };
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
};

// ---------------------------------------------------------------------------
// Builder tests
// ---------------------------------------------------------------------------

describe('buildAppSettingsSeed', () => {
  it('uses id="singleton" per docs/05 §3 AppSettings', () => {
    const s = buildAppSettingsSeed({});
    expect(s.id).toBe('singleton');
  });

  it('matches cost thresholds in SP-01 T-01-04', () => {
    const s = buildAppSettingsSeed({});
    expect(s.cost_per_book_warn_jpy).toBe(3000);
    expect(s.cost_per_book_pause_jpy).toBe(5000);
    expect(s.monthly_cost_yellow_jpy).toBe(40000);
    expect(s.monthly_cost_orange_jpy).toBe(47500);
    expect(s.monthly_cost_red_jpy).toBe(50000);
  });

  it('seeds ai_disclosure_text as empty by default (本文には AI 開示文を入れない運用)', () => {
    const s = buildAppSettingsSeed({});
    expect(s.ai_disclosure_text).toBe(DEFAULT_AI_DISCLOSURE_TEXT);
    expect(DEFAULT_AI_DISCLOSURE_TEXT).toBe('');
  });

  it('uses MAIL_TO from env when set, otherwise fallback', () => {
    expect(buildAppSettingsSeed({ MAIL_TO: 'me@example.com' }).notification_email_to).toBe(
      'me@example.com',
    );
    expect(buildAppSettingsSeed({}).notification_email_to).toMatch(/@/);
  });
});

describe('buildPromptSeeds', () => {
  const seeds = buildPromptSeeds();

  it('produces one default (genre=null) row per role (ジャンル別は {genre_guidance} 注入で対応)', () => {
    expect(PROMPT_GENRE_AXES.length).toBe(1);
    expect(PROMPT_GENRE_AXES[0]).toBeNull();
    expect(seeds.length).toBe(PROMPT_ROLES.length);
  });

  it('every role gets exactly one genre=null default row', () => {
    for (const role of PROMPT_ROLES) {
      const rows = seeds.filter((s) => s.role === role);
      expect(rows.length).toBe(1);
      expect(rows[0]!.genre).toBeNull();
    }
  });

  it('PROMPT_GENRE_AXES is exactly [null] (default-only seeding)', () => {
    expect(PROMPT_GENRE_AXES).toEqual([null]);
    // PROMPT_GENRES は旧 import 互換のため残置 (3 ジャンル名)。
    expect(PROMPT_GENRES.length).toBe(3);
  });

  it('genre-varying roles embed the {genre_guidance} injection token', () => {
    const varyingRoles = [
      'marketer',
      'marketer_plan',
      'writer',
      'editor',
      'thumbnail_text',
      'thumbnail_image',
    ] as const;
    for (const role of varyingRoles) {
      const row = seeds.find((s) => s.role === role);
      expect(row?.body).toContain('{genre_guidance}');
    }
  });

  it('all seeds are v1 active and created_by=system', () => {
    for (const s of seeds) {
      expect(s.version).toBe(1);
      expect(s.status).toBe('active');
      expect(s.created_by).toBe('system');
    }
  });

  it('no duplicate (role, genre, version) tuples', () => {
    const keys = seeds.map((s) => `${s.role}|${s.genre ?? 'null'}|${s.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('buildModelAssignmentSeeds', () => {
  const seeds = buildModelAssignmentSeeds();

  it('produces one row per role with genre=null (docs/01 §7.3)', () => {
    expect(seeds.length).toBe(PROMPT_ROLES.length);
    for (const s of seeds) {
      expect(s.genre).toBeNull();
      expect(s.status).toBe('active');
    }
  });

  it('marketer and optimizer use claude-opus-4-7', () => {
    expect(seeds.find((s) => s.role === 'marketer')?.model).toBe('claude-opus-4-7');
    expect(seeds.find((s) => s.role === 'optimizer')?.model).toBe('claude-opus-4-7');
  });

  it('writer/editor/judge/thumbnail_text/cover_text_check use claude-sonnet-4-6', () => {
    for (const role of ['writer', 'editor', 'judge', 'thumbnail_text', 'cover_text_check', 'readings'] as const) {
      expect(seeds.find((s) => s.role === role)?.model).toBe('claude-sonnet-4-6');
      expect(seeds.find((s) => s.role === role)?.provider).toBe('anthropic');
    }
  });

  it('thumbnail_image uses openai gpt-image-1', () => {
    const s = seeds.find((s) => s.role === 'thumbnail_image');
    expect(s?.provider).toBe('openai');
    expect(s?.model).toBe('gpt-image-1');
  });
});

describe('buildUserSeed', () => {
  it('returns null when env is missing', () => {
    expect(buildUserSeed({})).toBeNull();
    expect(buildUserSeed({ AUTH_USERNAME: 'admin' })).toBeNull();
    expect(buildUserSeed({ AUTH_PASSWORD_HASH: 'hash' })).toBeNull();
  });

  it('returns a seed when both env vars are set', () => {
    const seed = buildUserSeed({ AUTH_USERNAME: 'admin', AUTH_PASSWORD_HASH: '$2b$12$abc' });
    expect(seed).toEqual({ username: 'admin', password_hash: '$2b$12$abc' });
  });
});

// ---------------------------------------------------------------------------
// runSeed integration (mock prisma)
// ---------------------------------------------------------------------------

describe('runSeed', () => {
  it('creates all expected rows on a fresh database', async () => {
    const prisma = makePrismaMock();
    const result = await runSeed(
      prisma as never,
      { AUTH_USERNAME: 'admin', AUTH_PASSWORD_HASH: '$2b$12$abc' },
      silentLogger,
    );

    expect(result.appSettings).toBe(1);
    expect(result.prompts).toBe(buildPromptSeeds().length);
    expect(result.modelAssignments).toBe(buildModelAssignmentSeeds().length);
    expect(result.user).toBe(1);

    expect(prisma.appSettings.rows.length).toBe(1);
    expect(prisma.prompt.rows.length).toBe(buildPromptSeeds().length);
    expect(prisma.modelAssignment.rows.length).toBe(buildModelAssignmentSeeds().length);
    expect(prisma.user.rows.length).toBe(1);
  });

  it('skips user when env is missing and logs a warning', async () => {
    const prisma = makePrismaMock();
    const warns: string[] = [];
    const result = await runSeed(
      prisma as never,
      {},
      { info: () => undefined, warn: (m) => warns.push(m) },
    );
    expect(result.user).toBe(0);
    expect(prisma.user.rows.length).toBe(0);
    expect(warns.some((m) => /AUTH_USERNAME/.test(m))).toBe(true);
  });

  it('is idempotent — second run does not add rows', async () => {
    const prisma = makePrismaMock();
    const env = { AUTH_USERNAME: 'admin', AUTH_PASSWORD_HASH: '$2b$12$abc' };
    await runSeed(prisma as never, env, silentLogger);
    const after1 = {
      appSettings: prisma.appSettings.rows.length,
      prompts: prisma.prompt.rows.length,
      modelAssignments: prisma.modelAssignment.rows.length,
      user: prisma.user.rows.length,
    };
    await runSeed(prisma as never, env, silentLogger);
    const after2 = {
      appSettings: prisma.appSettings.rows.length,
      prompts: prisma.prompt.rows.length,
      modelAssignments: prisma.modelAssignment.rows.length,
      user: prisma.user.rows.length,
    };
    expect(after2).toEqual(after1);
  });

  it('preserves user-overridden prompt body on re-seed', async () => {
    const prisma = makePrismaMock();
    await runSeed(prisma as never, {}, silentLogger);
    const writer = prisma.prompt.rows.find(
      (r) => r.role === 'writer' && r.genre === null,
    );
    if (!writer) throw new Error('writer prompt missing');
    writer.body = 'USER_OVERRIDDEN_BODY';
    writer.created_by = 'optimizer:abc';
    await runSeed(prisma as never, {}, silentLogger);
    const afterReSeed = prisma.prompt.rows.find(
      (r) => r.role === 'writer' && r.genre === null,
    );
    expect(afterReSeed?.body).toBe('USER_OVERRIDDEN_BODY');
    // created_by は system 印に戻る (運用者が再認識できるよう)
    expect(afterReSeed?.created_by).toBe('system');
  });

  it('preserves user-overridden model assignment on re-seed', async () => {
    const prisma = makePrismaMock();
    await runSeed(prisma as never, {}, silentLogger);
    const writer = prisma.modelAssignment.rows.find(
      (r) => r.role === 'writer' && r.status === 'active',
    );
    if (!writer) throw new Error('writer assignment missing');
    writer.model = 'claude-haiku-test';
    await runSeed(prisma as never, {}, silentLogger);
    const after = prisma.modelAssignment.rows.find(
      (r) => r.role === 'writer' && r.status === 'active',
    );
    expect(after?.model).toBe('claude-haiku-test');
  });
});
