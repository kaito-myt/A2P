import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dbRoot = join(here, '..');
const schemaPath = join(dbRoot, 'schema.prisma');
const migrationsDir = join(dbRoot, 'migrations');

// docs/05 §3 + T-02-13 (ApiCredential) + T-12-01 (SalesFetchRun) で定義された 32 model 全てがスキーマに存在することを担保する。
const EXPECTED_MODELS = [
  'User',
  'Account',
  'PublishingPlan',
  'ThemeCandidate',
  'Book',
  'Outline',
  'Chapter',
  'ChapterRevision',
  'CoverTextProposal',
  'Cover',
  'KdpMetadata',
  'KdpSubmissionProgress',
  'Kdp2FaCode',
  'Artifact',
  'Job',
  'BatchPlan',
  'BatchPlanItem',
  'ModelCatalog',
  'ModelAssignment',
  'Prompt',
  'PromptProposal',
  'EvalResult',
  'TokenUsage',
  'SalesRecord',
  'SalesFetchRun',
  'Alert',
  'AuditLog',
  'RevisionComment',
  'RevisionRun',
  'BookLock',
  'AppSettings',
  'ApiCredential',
] as const;

describe('schema.prisma', () => {
  const schema = readFileSync(schemaPath, 'utf8');

  it('contains all 32 docs/05 §3 models', () => {
    for (const model of EXPECTED_MODELS) {
      expect(schema).toMatch(new RegExp(`^model\\s+${model}\\b`, 'm'));
    }
  });

  it('declares 32 models exactly', () => {
    const matches = schema.match(/^model\s+\w+/gm) ?? [];
    expect(matches.length).toBe(EXPECTED_MODELS.length);
  });

  it('sets generator output to ./generated', () => {
    expect(schema).toMatch(/generator\s+client\s*\{[^}]*output\s*=\s*"\.\/generated"/);
  });

  it('uses postgresql provider', () => {
    expect(schema).toMatch(/datasource\s+db\s*\{[^}]*provider\s*=\s*"postgresql"/);
  });
});

describe('migrations', () => {
  it('has migration_lock.toml pinned to postgresql', () => {
    const lock = readFileSync(join(migrationsDir, 'migration_lock.toml'), 'utf8');
    expect(lock).toMatch(/provider\s*=\s*"postgresql"/);
  });

  it('contains an init migration', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(dirs.some((d) => d.endsWith('_init'))).toBe(true);
  });

  it('init migration creates all 30 tables', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.endsWith('_init'))
      .map((d) => d.name);
    expect(dirs.length).toBeGreaterThan(0);
    const initDir = dirs[0];
    if (!initDir) throw new Error('init migration missing');
    const sql = readFileSync(join(migrationsDir, initDir, 'migration.sql'), 'utf8');
    // docs/05 §3 の @@map で定義されたテーブル名 30 件
    const expectedTables = [
      'users',
      'accounts',
      'publishing_plans',
      'theme_candidates',
      'books',
      'outlines',
      'chapters',
      'chapter_revisions',
      'cover_text_proposals',
      'covers',
      'kdp_metadata',
      'kdp_submission_progress',
      'kdp_2fa_codes',
      'artifacts',
      'jobs',
      'batch_plans',
      'batch_plan_items',
      'model_catalog',
      'model_assignments',
      'prompts',
      'prompt_proposals',
      'eval_results',
      'token_usage',
      'sales_records',
      'alerts',
      'audit_log',
      'revision_comments',
      'revision_runs',
      'book_locks',
      'app_settings',
    ];
    for (const t of expectedTables) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE "${t}"`));
    }
  });

  it('add_partial_uniques migration defines both partial UNIQUE indexes', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.endsWith('_add_partial_uniques'))
      .map((d) => d.name);
    expect(dirs.length).toBe(1);
    const dir = dirs[0];
    if (!dir) throw new Error('add_partial_uniques migration missing');
    const sql = readFileSync(join(migrationsDir, dir, 'migration.sql'), 'utf8');
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "model_assignments_role_genre_active_key"[\s\S]*WHERE "status" = 'active'/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "prompts_role_genre_active_key"[\s\S]*WHERE "status" = 'active'/,
    );
  });

  it('add_partial_uniques sorts after init', () => {
    const dirs = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const initIdx = dirs.findIndex((d) => d.endsWith('_init'));
    const partialIdx = dirs.findIndex((d) => d.endsWith('_add_partial_uniques'));
    expect(initIdx).toBeGreaterThanOrEqual(0);
    expect(partialIdx).toBeGreaterThan(initIdx);
  });
});

describe('packages/db client singleton', () => {
  it('exports prisma singleton from generated client', () => {
    const indexSrc = readFileSync(join(dbRoot, 'index.ts'), 'utf8');
    expect(indexSrc).toMatch(/globalForPrisma/);
    expect(indexSrc).toMatch(/new PrismaClient/);
    expect(indexSrc).toMatch(/process\.env\.NODE_ENV !== 'production'/);
  });

  it('generated client is present', () => {
    expect(existsSync(join(dbRoot, 'generated', 'index.d.ts'))).toBe(true);
  });
});
