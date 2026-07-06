'use server';

/**
 * 著者名マスタ / レーベル名マスタ の Server Actions。
 *
 * テーマ作成時にプルダウンで選択する「著者名」「レーベル名」を登録・編集・アーカイブする。
 * 単一運営者前提のため薄い CRUD。業務ロジックは zod 検証 + prisma 直呼び。
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isA2PError, fail, ok, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { messages } from '@/lib/messages';

const m = messages.masters;

const CreateAuthorSchema = z.object({
  name: z.string().trim().min(1).max(120),
  name_kana: z.string().trim().max(200).optional(),
  name_romaji: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
});
const UpdateAuthorSchema = CreateAuthorSchema.extend({ id: z.string().min(1) });

const CreateLabelSchema = z.object({
  name: z.string().trim().min(1).max(120),
  note: z.string().trim().max(500).optional(),
});
const UpdateLabelSchema = CreateLabelSchema.extend({ id: z.string().min(1) });

const IdSchema = z.object({ id: z.string().min(1), archived: z.boolean().optional() });

function guard<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  return fn().catch((err) => {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', m.errors.unknown);
  });
}

function revalidate() {
  revalidatePath('/masters');
  // テーマ詳細のプルダウンにも反映させる。
  revalidatePath('/themes', 'layout');
}

// ---------------------------------------------------------------------------
// 著者名マスタ
// ---------------------------------------------------------------------------

export async function createAuthorName(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    await getSessionOrThrow();
    const parsed = CreateAuthorSchema.safeParse(input);
    if (!parsed.success) return fail('validation', m.errors.validation, parsed.error.flatten());
    const row = await prisma.authorName.create({
      data: {
        name: parsed.data.name,
        name_kana: parsed.data.name_kana || null,
        name_romaji: parsed.data.name_romaji || null,
        note: parsed.data.note || null,
      },
      select: { id: true },
    });
    revalidate();
    return ok(row);
  });
}

export async function updateAuthorName(input: unknown): Promise<ActionResult<void>> {
  return guard(async () => {
    await getSessionOrThrow();
    const parsed = UpdateAuthorSchema.safeParse(input);
    if (!parsed.success) return fail('validation', m.errors.validation, parsed.error.flatten());
    await prisma.authorName.update({
      where: { id: parsed.data.id },
      data: {
        name: parsed.data.name,
        name_kana: parsed.data.name_kana || null,
        name_romaji: parsed.data.name_romaji || null,
        note: parsed.data.note || null,
      },
    });
    revalidate();
    return ok(undefined as void);
  });
}

export async function setAuthorNameArchived(input: unknown): Promise<ActionResult<void>> {
  return guard(async () => {
    await getSessionOrThrow();
    const parsed = IdSchema.safeParse(input);
    if (!parsed.success) return fail('validation', m.errors.validation, parsed.error.flatten());
    await prisma.authorName.update({
      where: { id: parsed.data.id },
      data: { status: parsed.data.archived ? 'archived' : 'active' },
    });
    revalidate();
    return ok(undefined as void);
  });
}

// ---------------------------------------------------------------------------
// レーベル名マスタ
// ---------------------------------------------------------------------------

export async function createLabelName(input: unknown): Promise<ActionResult<{ id: string }>> {
  return guard(async () => {
    await getSessionOrThrow();
    const parsed = CreateLabelSchema.safeParse(input);
    if (!parsed.success) return fail('validation', m.errors.validation, parsed.error.flatten());
    const row = await prisma.labelName.create({
      data: { name: parsed.data.name, note: parsed.data.note || null },
      select: { id: true },
    });
    revalidate();
    return ok(row);
  });
}

export async function updateLabelName(input: unknown): Promise<ActionResult<void>> {
  return guard(async () => {
    await getSessionOrThrow();
    const parsed = UpdateLabelSchema.safeParse(input);
    if (!parsed.success) return fail('validation', m.errors.validation, parsed.error.flatten());
    await prisma.labelName.update({
      where: { id: parsed.data.id },
      data: { name: parsed.data.name, note: parsed.data.note || null },
    });
    revalidate();
    return ok(undefined as void);
  });
}

export async function setLabelNameArchived(input: unknown): Promise<ActionResult<void>> {
  return guard(async () => {
    await getSessionOrThrow();
    const parsed = IdSchema.safeParse(input);
    if (!parsed.success) return fail('validation', m.errors.validation, parsed.error.flatten());
    await prisma.labelName.update({
      where: { id: parsed.data.id },
      data: { status: parsed.data.archived ? 'archived' : 'active' },
    });
    revalidate();
    return ok(undefined as void);
  });
}
