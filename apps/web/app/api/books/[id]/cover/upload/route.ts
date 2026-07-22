/**
 * POST /api/books/[id]/cover/upload — 手動作成したカバー画像をアップロードして採用する (F-041b)。
 *
 * ブラウザ版 ChatGPT 等で自作した表紙を、書籍ライブラリ(カバータブ)からアップロードして
 * 採用カバーに差し替える。処理:
 *   1. 認証必須。
 *   2. multipart/form-data の 'file' を受け取り、PNG/JPEG/WebP を判定 (sharp 不使用の軽量判定)。
 *   3. R2 に保存 (books/{id}/covers/raw/{coverId}.{ext})。
 *   4. Cover 行を status='adopted' で作成し、同一書籍の他カバーを rejected に。
 *   5. pipeline.book.export を enqueue して KDP カバーファイル(実寸PNG)を作り直す。
 *
 * KDP 実寸への変換・正規化は worker(sharp)側の export が行う。
 */
import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';

import { prisma } from '@a2p/db';
import { AuthError } from '@a2p/contracts';
import { uploadBuffer } from '@a2p/storage';
import { bookArtifact } from '@a2p/storage/keys';

import { getSessionOrThrow } from '@/lib/auth-helpers';
import { enqueueJob } from '@/lib/graphile-client';
import { detectImage } from '@/lib/image-dimensions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 20 * 1024 * 1024; // 20MB
const EXPORT_TASK = 'pipeline.book.export';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSessionOrThrow().catch((err) => {
    if (err instanceof AuthError) return null;
    throw err;
  });
  if (!session) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const { id: bookId } = await params;

  const book = await prisma.book.findUnique({ where: { id: bookId }, select: { id: true } });
  if (!book) return NextResponse.json({ ok: false, error: 'book_not_found' }, { status: 404 });

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get('file');
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_form' }, { status: 400 });
  }
  if (!file) return NextResponse.json({ ok: false, error: 'file_required' }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: 'file_too_large' }, { status: 413 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const info = detectImage(buffer);
  if (!info) {
    return NextResponse.json({ ok: false, error: 'unsupported_image' }, { status: 415 });
  }

  const coverId = randomUUID().replace(/-/g, '');
  const r2Key = bookArtifact(bookId, 'cover_source', `${coverId}.${info.ext}`);
  await uploadBuffer(r2Key, buffer, info.contentType);

  // Cover 作成(採用) + 他カバー却下 + export ジョブ作成をトランザクションで。
  const exportJobId = await prisma.$transaction(async (tx) => {
    await tx.cover.create({
      data: {
        id: coverId,
        book_id: bookId,
        r2_key: r2Key,
        prompt_used: '(手動アップロード)',
        width: info.width,
        height: info.height,
        status: 'adopted',
        generation_meta_json: {
          source: 'manual_upload',
          content_type: info.contentType,
          original_filename: file!.name?.slice(0, 200) ?? null,
          uploaded_by: session.user.id,
        },
      },
    });
    await tx.cover.updateMany({
      where: { book_id: bookId, id: { not: coverId }, status: { not: 'rejected' } },
      data: { status: 'rejected' },
    });
    const job = await tx.job.create({
      data: { kind: EXPORT_TASK, book_id: bookId, status: 'queued', payload_json: { book_id: bookId } },
    });
    await tx.auditLog.create({
      data: {
        actor_id: session.user.id,
        action: 'covers.manual_upload',
        target_kind: 'cover',
        target_id: coverId,
        after_json: { book_id: bookId, r2_key: r2Key, width: info.width, height: info.height, export_job_id: job.id },
      },
    });
    return job.id;
  });

  try {
    await enqueueJob(EXPORT_TASK, { book_id: bookId, job_id: exportJobId });
  } catch {
    // enqueue 失敗でもカバーは採用済み。export は後続の手動/自動で拾える。
  }

  return NextResponse.json({ ok: true, cover_id: coverId });
}
