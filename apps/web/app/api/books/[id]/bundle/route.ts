/**
 * GET /api/books/[id]/bundle — 書籍の入稿素材を 1 つの ZIP でまとめてダウンロード。
 *
 * 同梱物:
 *   - 本文 Word  : `<title>.docx`   (artifacts.kind='docx')
 *   - 本文 PDF   : `<title>.pdf`    (artifacts.kind='pdf')
 *   - カバー画像 : `<title>_cover.jpg` (covers の adopted、無ければ最初の generated)
 *
 * 認証必須。R2 から実体を取得し JSZip で固めてストリーム返却する。
 */
import JSZip from 'jszip';
import { NextResponse } from 'next/server';

import { prisma } from '@a2p/db';
import { AuthError } from '@a2p/contracts';
import { downloadBuffer } from '@a2p/storage';

import { getSessionOrThrow } from '@/lib/auth-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await getSessionOrThrow();
  } catch (err) {
    if (err instanceof AuthError) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
    throw err;
  }

  const { id } = await params;

  const book = await prisma.book.findUnique({
    where: { id },
    select: {
      title: true,
      artifacts: {
        where: { kind: { in: ['docx', 'pdf'] } },
        select: { kind: true, r2_key: true },
      },
      covers: {
        select: { r2_key: true, status: true, created_at: true },
        orderBy: { created_at: 'asc' },
      },
    },
  });

  if (!book) {
    return new NextResponse('Not Found', { status: 404 });
  }

  const safeTitle = (book.title || 'book').replace(/[\\/:*?"<>|]/g, '_');

  // 取得対象 (key, zip 内ファイル名) を組み立てる。
  const targets: Array<{ key: string; name: string }> = [];
  const docx = book.artifacts.find((a) => a.kind === 'docx');
  if (docx) targets.push({ key: docx.r2_key, name: `${safeTitle}.docx` });
  const pdf = book.artifacts.find((a) => a.kind === 'pdf');
  if (pdf) targets.push({ key: pdf.r2_key, name: `${safeTitle}.pdf` });
  const cover =
    book.covers.find((c) => c.status === 'adopted') ?? book.covers[0] ?? null;
  if (cover) targets.push({ key: cover.r2_key, name: `${safeTitle}_cover.jpg` });

  if (targets.length === 0) {
    return new NextResponse('No downloadable assets for this book', { status: 404 });
  }

  const zip = new JSZip();
  let added = 0;
  for (const t of targets) {
    const buf = await downloadBuffer(t.key);
    if (buf) {
      zip.file(t.name, buf);
      added += 1;
    }
  }

  if (added === 0) {
    return new NextResponse('Assets could not be retrieved from storage', { status: 502 });
  }

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const filename = `${safeTitle}.zip`;
  const encoded = encodeURIComponent(filename);

  return new NextResponse(new Uint8Array(zipBuffer), {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encoded}`,
      'Content-Length': String(zipBuffer.length),
    },
  });
}
