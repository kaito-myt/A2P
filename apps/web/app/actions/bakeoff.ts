'use server';

/**
 * F-053 — モデル・バエオフの Server Action。
 * サンプル入力を複数モデルで走らせて比較する run を作成し worker に投入する。
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { isA2PError, fail, ok, type ActionResult } from '@a2p/contracts';
import { prisma } from '@a2p/db';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { enqueueJob } from '@/lib/graphile-client';
import { messages } from '@/lib/messages';

const BAKEOFF_RUN_TASK = 'bakeoff.run';

const StartSchema = z.object({
  role: z.string().min(1),
  genre: z.string().optional(),
  input_label: z.string().min(1).max(200),
  user: z.string().min(1).max(8000),
  system_extra: z.string().max(2000).optional(),
  candidates: z
    .array(z.object({ provider: z.string().min(1), model: z.string().min(1) }))
    .min(2)
    .max(8),
});

export async function startBakeoff(
  input: unknown,
): Promise<ActionResult<{ run_id: string }>> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.bakeoff.errors.start);
  }

  const parsed = StartSchema.safeParse(input);
  if (!parsed.success) return fail('validation', messages.bakeoff.errors.start);
  const { role, genre, input_label, user, system_extra, candidates } = parsed.data;

  try {
    const run = await prisma.bakeoffRun.create({
      data: {
        role,
        genre: genre && genre.length > 0 ? genre : null,
        input_label,
        input_json: { user, ...(system_extra ? { system_extra } : {}), candidates },
        status: 'queued',
      },
    });
    await enqueueJob(BAKEOFF_RUN_TASK, { run_id: run.id });
    revalidatePath('/models/bakeoff');
    return ok({ run_id: run.id });
  } catch (err) {
    if (isA2PError(err)) return err.toActionResult();
    return fail('unknown', messages.bakeoff.errors.start);
  }
}
