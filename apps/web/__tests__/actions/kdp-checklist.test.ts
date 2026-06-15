/**
 * kdp-checklist-core.ts unit tests (T-08-04, F-020).
 *
 * Checks:
 *  1. Single field update merges into existing checklist_state_json without losing other fields
 *  2. Upsert creates the row when absent (no existing KdpSubmissionProgress)
 *  3. Invalid input rejected (zod validation)
 *  4. checked_at is set when field transitions to checked=true
 *  5. checked_at is cleared when field transitions to checked=false
 *  6. Book not found → not_found error
 */
import { describe, expect, it, vi } from 'vitest';
import { isFail, isOk } from '@a2p/contracts';

import {
  updateChecklistCore,
  type ChecklistDeps,
  type KdpSubmissionProgressRepo,
  type BookExistsRepo,
  type ChecklistStateJson,
  type KdpSubmissionProgressRow,
} from '../../lib/kdp-checklist-core';

const FROZEN_NOW = new Date('2026-06-05T10:00:00.000Z');

const EXISTING_STATE: ChecklistStateJson = {
  title: { copied: true, checked: false },
  subtitle: { copied: false, checked: false },
  author: { copied: true, checked: true, checked_at: '2026-06-04T08:00:00.000Z' },
};

const EXISTING_ROW: KdpSubmissionProgressRow = {
  id: 'prog_1',
  book_id: 'book_1',
  checklist_state_json: EXISTING_STATE,
};

function makeDeps(opts: {
  existingProgress?: KdpSubmissionProgressRow | null;
  bookExists?: boolean;
} = {}): {
  deps: ChecklistDeps;
  spies: {
    findProgress: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    findBook: ReturnType<typeof vi.fn>;
  };
} {
  const bookExists = opts.bookExists !== undefined ? opts.bookExists : true;
  const existingProgress =
    opts.existingProgress !== undefined ? opts.existingProgress : EXISTING_ROW;

  const findBook = vi.fn(async () =>
    bookExists ? { id: 'book_1' } : null,
  );

  const findProgress = vi.fn(async () => existingProgress);

  const upsert = vi.fn(async ({
    where,
    create,
    update,
  }: Parameters<KdpSubmissionProgressRepo['upsert']>[0]): Promise<KdpSubmissionProgressRow> => {
    const base = existingProgress ?? {
      id: 'prog_new',
      book_id: where.book_id,
      checklist_state_json: {},
    };
    return {
      ...base,
      checklist_state_json: existingProgress
        ? update.checklist_state_json
        : create.checklist_state_json,
    };
  });

  const bookRepo: BookExistsRepo = { findUnique: findBook };
  const kdpSubmissionProgressRepo: KdpSubmissionProgressRepo = {
    findUnique: findProgress,
    upsert,
  };

  return {
    deps: {
      kdpSubmissionProgressRepo,
      bookRepo,
      session: { user: { id: 'u_1', username: 'operator' } },
      now: () => FROZEN_NOW,
    },
    spies: { findProgress, upsert, findBook },
  };
}

// ---------------------------------------------------------------------------
// Test 1: single field update merges without losing other fields
// ---------------------------------------------------------------------------

describe('updateChecklistCore — partial merge', () => {
  it('updates a single field while preserving all other existing fields', async () => {
    const { deps, spies } = makeDeps();
    const result = await updateChecklistCore(
      { book_id: 'book_1', field: 'title', checked: true },
      deps,
    );

    expect(isOk(result)).toBe(true);
    expect(spies.upsert).toHaveBeenCalledTimes(1);

    const upsertArg = spies.upsert.mock.calls[0]?.[0];
    const merged: ChecklistStateJson = upsertArg.update.checklist_state_json;

    // updated field
    expect(merged['title']?.checked).toBe(true);
    expect(merged['title']?.copied).toBe(true); // preserved from existing
    expect(merged['title']?.checked_at).toBe(FROZEN_NOW.toISOString());

    // untouched fields remain intact
    expect(merged['subtitle']).toEqual(EXISTING_STATE.subtitle);
    expect(merged['author']).toEqual(EXISTING_STATE.author);
  });

  it('updates only copied without touching checked', async () => {
    const { deps, spies } = makeDeps();
    const result = await updateChecklistCore(
      { book_id: 'book_1', field: 'subtitle', copied: true },
      deps,
    );

    expect(isOk(result)).toBe(true);
    const upsertArg = spies.upsert.mock.calls[0]?.[0];
    const merged: ChecklistStateJson = upsertArg.update.checklist_state_json;

    expect(merged['subtitle']?.copied).toBe(true);
    expect(merged['subtitle']?.checked).toBe(false); // preserved

    // author still intact
    expect(merged['author']?.checked_at).toBe('2026-06-04T08:00:00.000Z');
  });

  it('clears checked_at when checked transitions to false', async () => {
    const { deps, spies } = makeDeps();
    // author is currently checked=true with checked_at
    const result = await updateChecklistCore(
      { book_id: 'book_1', field: 'author', checked: false },
      deps,
    );

    expect(isOk(result)).toBe(true);
    const upsertArg = spies.upsert.mock.calls[0]?.[0];
    const merged: ChecklistStateJson = upsertArg.update.checklist_state_json;

    expect(merged['author']?.checked).toBe(false);
    expect(merged['author']?.checked_at).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 2: upsert creates row when absent
// ---------------------------------------------------------------------------

describe('updateChecklistCore — upsert when row absent', () => {
  it('creates a new row with just the specified field when no existing progress', async () => {
    const { deps, spies } = makeDeps({ existingProgress: null });
    const result = await updateChecklistCore(
      { book_id: 'book_1', field: 'description', copied: true },
      deps,
    );

    expect(isOk(result)).toBe(true);
    expect(spies.upsert).toHaveBeenCalledTimes(1);

    const upsertArg = spies.upsert.mock.calls[0]?.[0];

    // create payload
    const createState: ChecklistStateJson = upsertArg.create.checklist_state_json;
    expect(createState['description']?.copied).toBe(true);
    expect(createState['description']?.checked).toBe(false);
    // screenshot_r2_keys initialized empty
    expect(upsertArg.create.screenshot_r2_keys).toEqual([]);

    // where clause
    expect(upsertArg.where.book_id).toBe('book_1');
  });

  it('creates row with checked=true and sets checked_at', async () => {
    const { deps, spies } = makeDeps({ existingProgress: null });
    await updateChecklistCore(
      { book_id: 'book_1', field: 'price', checked: true },
      deps,
    );

    const upsertArg = spies.upsert.mock.calls[0]?.[0];
    const createState: ChecklistStateJson = upsertArg.create.checklist_state_json;
    expect(createState['price']?.checked).toBe(true);
    expect(createState['price']?.checked_at).toBe(FROZEN_NOW.toISOString());
  });
});

// ---------------------------------------------------------------------------
// Test 3: invalid input rejected
// ---------------------------------------------------------------------------

describe('updateChecklistCore — validation', () => {
  it('missing book_id fails with validation code', async () => {
    const { deps, spies } = makeDeps();
    const result = await updateChecklistCore(
      { field: 'title', checked: true },
      deps,
    );
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
    expect(spies.upsert).not.toHaveBeenCalled();
  });

  it('missing field fails with validation code', async () => {
    const { deps, spies } = makeDeps();
    const result = await updateChecklistCore(
      { book_id: 'book_1' },
      deps,
    );
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
    expect(spies.upsert).not.toHaveBeenCalled();
  });

  it('empty book_id fails with validation code', async () => {
    const { deps, spies } = makeDeps();
    const result = await updateChecklistCore(
      { book_id: '', field: 'title', checked: true },
      deps,
    );
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
    expect(spies.upsert).not.toHaveBeenCalled();
  });

  it('non-boolean checked fails with validation code', async () => {
    const { deps, spies } = makeDeps();
    const result = await updateChecklistCore(
      { book_id: 'book_1', field: 'title', checked: 'yes' },
      deps,
    );
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
    expect(spies.upsert).not.toHaveBeenCalled();
  });

  it('null input fails with validation code', async () => {
    const { deps } = makeDeps();
    const result = await updateChecklistCore(null, deps);
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('validation');
  });
});

// ---------------------------------------------------------------------------
// Test 4: book not found
// ---------------------------------------------------------------------------

describe('updateChecklistCore — book not found', () => {
  it('returns not_found when book does not exist', async () => {
    const { deps, spies } = makeDeps({ bookExists: false });
    const result = await updateChecklistCore(
      { book_id: 'nonexistent', field: 'title', checked: true },
      deps,
    );
    expect(isFail(result)).toBe(true);
    if (isFail(result)) expect(result.error.code).toBe('not_found');
    expect(spies.upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 5: existing checked_at preserved when no change to checked
// ---------------------------------------------------------------------------

describe('updateChecklistCore — checked_at preservation', () => {
  it('preserves existing checked_at when only copied is updated on already-checked field', async () => {
    const { deps, spies } = makeDeps();
    // author is checked=true with checked_at, update only copied
    const result = await updateChecklistCore(
      { book_id: 'book_1', field: 'author', copied: false },
      deps,
    );

    expect(isOk(result)).toBe(true);
    const upsertArg = spies.upsert.mock.calls[0]?.[0];
    const merged: ChecklistStateJson = upsertArg.update.checklist_state_json;

    expect(merged['author']?.checked).toBe(true);
    // original checked_at preserved since checked was not changed
    expect(merged['author']?.checked_at).toBe('2026-06-04T08:00:00.000Z');
    expect(merged['author']?.copied).toBe(false);
  });
});
