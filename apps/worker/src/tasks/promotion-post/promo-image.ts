/**
 * F-058 — IG/TikTok 販促投稿用の AI 画像を「本ごとに 1 枚」遅延生成して R2 に保存する。
 *
 * Instagram/TikTok は画像/動画が必須のため、投稿時にこの画像の署名付き URL を Ayrshare に渡す。
 * 生成は本ごとに 1 回だけ（`books.promo_image_key` にキャッシュ）。文字化け回避のため
 * gpt-image-1 には文字を描かせない。
 */
import {
  generateImage as defaultGenerateImage,
  withImageLogging,
  type GenerateImageFn,
  type WithImageLoggingDeps,
} from '@a2p/agents';
import { bookPromoImage } from '@a2p/storage/keys';
import { createLogger, type Logger } from '@a2p/contracts/logger';

const NO_TEXT_GUARD =
  ' 重要: 画像内に文字・ロゴ・数字・記号を一切描かないこと。テキストなしの純粋なビジュアルのみ。';

interface PromoImagePrisma {
  book: {
    findUnique: (args: {
      where: { id: string };
      select: { promo_image_key: true; title: true; theme: { select: { genre: true } } };
    }) => Promise<{ promo_image_key: string | null; title: string; theme: { genre: string } | null } | null>;
    update: (args: {
      where: { id: string };
      data: { promo_image_key: string };
    }) => Promise<unknown>;
  };
}

interface UploadBufferFn {
  (key: string, buffer: Buffer, contentType: string): Promise<{ key: string }>;
}

export interface EnsureBookPromoImageDeps {
  prisma?: PromoImagePrisma;
  logger?: Logger;
  generateImage?: GenerateImageFn;
  withImageLoggingDeps?: WithImageLoggingDeps;
  uploadBuffer?: UploadBufferFn;
}

const GENRE_MOOD: Record<string, string> = {
  business: 'モダンで信頼感のあるビジネスの世界観。落ち着いた配色、洗練されたデスク周りや都市の朝',
  practical: '明るく実用的で親しみやすい生活の世界観。清潔感のある暖色、整った日常の道具',
  self_help: '前向きで温かい成長の世界観。柔らかな朝日、静かな自然、希望を感じる光',
};

/**
 * 本のテーマから、文字なしの販促ビジュアル用プロンプトを組み立てる。
 * 注意: **本・雑誌・表紙・看板など「文字が描かれる物体」を一切描かせない**。
 * gpt-image-1 は本を描くと表紙に文字化け日本語を入れてしまうため、テーマの世界観だけを
 * 情緒的なシーン/静物として描く。
 */
export function buildPromoImagePrompt(title: string, genre: string | null): string {
  const mood = (genre && GENRE_MOOD[genre]) || '洗練され、目を引く上質な世界観。暖色系で明るい';
  return (
    `Instagram/TikTok の投稿に使う、正方形の高品質で情緒的なビジュアル。` +
    `テーマ「${title.slice(0, 60)}」を象徴する世界観を、実写風の美しいシーンまたは静物で表現する。` +
    `雰囲気: ${mood}。` +
    `構図はミニマルで洗練され、SNSでスクロールの手を止める魅力があること。` +
    `厳守: 本・雑誌・表紙・紙・看板・ポスター・画面など「文字が入りうる物体」は描かない。` +
    `${NO_TEXT_GUARD}`
  );
}

async function defaultUploadBuffer(key: string, buffer: Buffer, contentType: string): Promise<{ key: string }> {
  const mod = await import('@a2p/storage/operations');
  return mod.uploadBuffer(key, buffer, contentType);
}

async function defaultPrisma(): Promise<PromoImagePrisma> {
  const mod = await import('@a2p/db');
  return mod.prisma as unknown as PromoImagePrisma;
}

/**
 * 本の販促画像 R2 キーを返す。未生成なら gpt-image-1 で 1 枚生成して保存する。
 * 生成不可(本が無い等)なら null。
 */
export async function ensureBookPromoImage(
  bookId: string,
  deps: EnsureBookPromoImageDeps = {},
): Promise<string | null> {
  const log = deps.logger ?? createLogger('worker.promotion.promo-image');
  const prisma = deps.prisma ?? (await defaultPrisma());
  const uploadBuffer = deps.uploadBuffer ?? defaultUploadBuffer;

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: { promo_image_key: true, title: true, theme: { select: { genre: true } } },
  });
  if (!book) return null;
  if (book.promo_image_key) return book.promo_image_key;

  const prompt = buildPromoImagePrompt(book.title, book.theme?.genre ?? null);
  const baseFn: GenerateImageFn = deps.generateImage ?? defaultGenerateImage;
  const genFn = withImageLogging(baseFn, { bookId, role: 'promo_image' }, deps.withImageLoggingDeps);

  const result = await genFn({ prompt, width: 1024, height: 1024, quality: 'medium', outputFormat: 'png' });
  const image = result.images[0];
  if (!image) {
    log.warn({ bookId }, 'promo image generation returned no image');
    return null;
  }

  const key = bookPromoImage(bookId);
  await uploadBuffer(key, image, 'image/png');
  await prisma.book.update({ where: { id: bookId }, data: { promo_image_key: key } });
  log.info({ bookId, key }, 'promo image generated');
  return key;
}
