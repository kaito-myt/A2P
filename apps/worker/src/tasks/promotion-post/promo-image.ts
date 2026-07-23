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
import { composePromoCreative, promoAccent } from '@a2p/output-image';
import { bookPromoImage, promotionPostImage } from '@a2p/storage/keys';
import { createLogger, type Logger } from '@a2p/contracts/logger';

const NO_TEXT_GUARD =
  ' 重要: 画像内に文字・ロゴ・数字・記号を一切描かないこと。テキストなしの純粋なビジュアルのみ。';

interface PromoImagePrisma {
  book: {
    findUnique: (args: {
      where: { id: string };
      select: {
        promo_image_key: true;
        title: true;
        theme: { select: { genre: true; hook: true; target_reader: true } };
      };
    }) => Promise<{
      promo_image_key: string | null;
      title: string;
      theme: { genre: string; hook: string | null; target_reader: string | null } | null;
    } | null>;
    update: (args: {
      where: { id: string };
      data: { promo_image_key: string };
    }) => Promise<unknown>;
  };
  cover: {
    findFirst: (args: {
      where: { book_id: string; status: string };
      select: { r2_key: true };
      orderBy?: { created_at: 'desc' };
    }) => Promise<{ r2_key: string } | null>;
  };
  coverTextProposal: {
    findFirst: (args: {
      where: { book_id: string };
      select: { band_copy: true };
      orderBy?: { created_at: 'desc' };
    }) => Promise<{ band_copy: string | null } | null>;
  };
}

type DownloadBufferFn = (key: string) => Promise<Buffer | null>;

interface UploadBufferFn {
  (key: string, buffer: Buffer, contentType: string): Promise<{ key: string }>;
}

export interface EnsureBookPromoImageDeps {
  prisma?: PromoImagePrisma;
  logger?: Logger;
  generateImage?: GenerateImageFn;
  withImageLoggingDeps?: WithImageLoggingDeps;
  uploadBuffer?: UploadBufferFn;
  downloadBuffer?: DownloadBufferFn;
  /** テスト差し替え用: 表紙＋背景から販促クリエイティブを合成する。 */
  compose?: typeof composePromoCreative;
}

const GENRE_MOOD: Record<string, string> = {
  business: 'モダンで信頼感のあるビジネスの世界観。落ち着いた配色、洗練されたデスク周りや都市の朝',
  practical: '明るく実用的で親しみやすい生活の世界観。清潔感のある暖色、整った日常の道具',
  self_help: '前向きで温かい成長の世界観。柔らかな朝日、静かな自然、希望を感じる光',
  money: '落ち着いた信頼感のある投資の世界観。深い緑や紺、静かな都市の朝',
  gambling: '躍動感のあるレースの世界観。ターフの緑、夕暮れの光、スピード感のある空気',
  health: '清潔で前向きな健康の世界観。朝の光、みずみずしい自然、穏やかな余白',
  study: '集中できる学びの世界観。静かな机、朝の光、整理された空間',
};

/** 文字なしの「背景」プロンプト（右側にテキストを載せるため余白を意識）。 */
export function buildPromoBackgroundPrompt(genre: string | null): string {
  const mood = (genre && GENRE_MOOD[genre]) || '洗練され上質な世界観。暖色系で明るく、柔らかなボケ味';
  return (
    `Instagram 販促用の正方形の背景画像。テーマの世界観を情緒的な実写風シーン/静物で表現。` +
    `雰囲気: ${mood}。` +
    `構図は左に主役の余白、全体は柔らかいボケ味で、右側と下側はやや暗めにして文字が乗せやすいこと。` +
    `厳守: 本・雑誌・表紙・紙・看板・ポスター・画面・人物の顔など「文字が入りうる物体」は描かない。` +
    `${NO_TEXT_GUARD}`
  );
}

/** 文章から「短く刺さる1フレーズ(8〜28字)」を抜き出す。無ければ null。 */
function pickHookPhrase(s: string | null): string | null {
  const clean = (s ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return null;
  // 句点・感嘆/疑問符で区切り、最初の手頃な長さの句を採用（「なぜ〜？」等のフックを拾う）。
  const parts = clean.split(/(?<=[。！？!?])/);
  for (const p of parts) {
    const t = p.trim().replace(/[『』「」（）()]/g, '').replace(/[。、]+$/, '');
    if (t.length >= 8 && t.length <= 28) return t;
  }
  const first = clean.replace(/[『』「」（）()]/g, '');
  return first.length >= 8 ? first.slice(0, 26) : null;
}

/**
 * 販促見出し（ベネフィット）を決める。優先順位:
 *   1. 帯コピー(band_copy) の冒頭フック（販売用に作られた最も刺さる一言）
 *   2. 想定読者(target_reader) を「〜へ」の簡潔な一言に（短いときのみ）
 *   3. フック(hook) の冒頭フレーズ
 *   4. 書名
 * 見出しは短く・切れないことが命なので、長い全文は使わない。
 */
export function toHeadline(
  bandCopy: string | null,
  hook: string | null,
  targetReader: string | null,
  title: string,
): string {
  const bc = pickHookPhrase(bandCopy);
  if (bc) return bc;
  const tr = (targetReader ?? '').replace(/\s+/g, ' ').trim();
  if (tr.length >= 4 && tr.length <= 28) {
    return /[へにをはがのな人方けたい]$/.test(tr) ? tr : `${tr}へ`;
  }
  const hk = pickHookPhrase(hook);
  if (hk) return hk;
  return title.slice(0, 28);
}

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

async function defaultDownloadBuffer(key: string): Promise<Buffer | null> {
  const mod = await import('@a2p/storage/operations');
  return mod.downloadBuffer(key);
}

/**
 * 本の販促画像 R2 キーを返す。未生成なら「デザイン販促クリエイティブ」を1枚作って保存する。
 *
 * 構成（売れる販促の原則に準拠）: 実際の表紙を主役に、gpt-image-2 で作った文字なし背景に
 * 合成し、「新刊/KU無料」バッジ・ベネフィット見出し(本のフック)・CTA を実フォントで焼き込む。
 * 表紙が無い本のみ、従来の文字なしムード画像にフォールバックする。生成不可なら null。
 */
export async function ensureBookPromoImage(
  bookId: string,
  deps: EnsureBookPromoImageDeps = {},
): Promise<string | null> {
  const log = deps.logger ?? createLogger('worker.promotion.promo-image');
  const prisma = deps.prisma ?? (await defaultPrisma());
  const uploadBuffer = deps.uploadBuffer ?? defaultUploadBuffer;
  const downloadBuffer = deps.downloadBuffer ?? defaultDownloadBuffer;
  const compose = deps.compose ?? composePromoCreative;

  const book = await prisma.book.findUnique({
    where: { id: bookId },
    select: {
      promo_image_key: true,
      title: true,
      theme: { select: { genre: true, hook: true, target_reader: true } },
    },
  });
  if (!book) return null;
  if (book.promo_image_key) return book.promo_image_key;

  const genre = book.theme?.genre ?? null;
  const baseFn: GenerateImageFn = deps.generateImage ?? defaultGenerateImage;
  const genFn = withImageLogging(baseFn, { bookId, role: 'promo_image' }, deps.withImageLoggingDeps);
  const key = bookPromoImage(bookId);

  // 採用済み表紙を取得（あれば「デザイン販促型」で合成）。
  const adopted = await prisma.cover.findFirst({
    where: { book_id: bookId, status: 'adopted' },
    select: { r2_key: true },
    orderBy: { created_at: 'desc' },
  });
  const coverBuf = adopted?.r2_key ? await downloadBuffer(adopted.r2_key) : null;

  // 帯コピー（販促見出しの最有力ソース）を取得。
  const ctp = await prisma.coverTextProposal.findFirst({
    where: { book_id: bookId },
    select: { band_copy: true },
    orderBy: { created_at: 'desc' },
  });

  // 背景（文字なし・ジャンルの世界観）を生成。JPEG は最後の合成で出力するので PNG で受ける。
  const bgResult = await genFn({
    prompt: coverBuf
      ? buildPromoBackgroundPrompt(genre)
      : buildPromoImagePrompt(book.title, genre),
    width: 1024,
    height: 1024,
    quality: 'medium',
    outputFormat: coverBuf ? 'png' : 'jpeg',
    ...(coverBuf ? {} : { outputCompression: 90 }),
  });
  const bg = bgResult.images[0];
  if (!bg) {
    log.warn({ bookId }, 'promo background generation returned no image');
    return null;
  }

  let finalImage: Buffer;
  if (coverBuf) {
    const headline = toHeadline(
      ctp?.band_copy ?? null,
      book.theme?.hook ?? null,
      book.theme?.target_reader ?? null,
      book.title,
    );
    // 想定読者を eyebrow に（見出しと重複する場合は省く）。
    const targetReader = book.theme?.target_reader?.trim();
    const eyebrow =
      targetReader && targetReader.length <= 28 && !headline.includes(targetReader) ? targetReader : undefined;
    finalImage = await compose(
      bg,
      coverBuf,
      {
        badge: '新刊',
        ku: 'KU 読み放題',
        headline,
        ...(eyebrow ? { eyebrow } : {}),
        // 見出しが書名と同一なら下段タイトルは省いて重複を避ける。
        title: headline === book.title ? '' : book.title,
        cta: 'プロフィールのリンクから',
      },
      { accent: promoAccent(genre) },
    );
    log.info({ bookId, key }, 'design promo creative composed (cover + headline)');
  } else {
    // 表紙が無い本: 従来のムード画像（JPEG）をそのまま採用。
    finalImage = bg;
    log.info({ bookId, key }, 'no adopted cover — fallback mood promo image');
  }

  await uploadBuffer(key, finalImage, 'image/jpeg');
  await prisma.book.update({ where: { id: bookId }, data: { promo_image_key: key } });
  return key;
}

/** 育成(value)投稿の本文から、文字なしのライフスタイル画像プロンプトを組み立てる。 */
export function buildValueImagePrompt(bodyHint: string): string {
  const hint = bodyHint
    .replace(/#\S+/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return (
    `Instagram 向けの正方形の高品質で情緒的なライフスタイル画像。前向きで上質、暖色系、` +
    `ミニマルで洗練された雰囲気。投稿の趣旨を象徴するシーン/静物で表現する: 「${hint}」。` +
    `厳守: 本・雑誌・表紙・紙・看板・画面など文字が入りうる物体は描かない。${NO_TEXT_GUARD}`
  );
}

export interface GenerateValuePostImageDeps {
  logger?: Logger;
  generateImage?: GenerateImageFn;
  withImageLoggingDeps?: WithImageLoggingDeps;
  uploadBuffer?: UploadBufferFn;
}

/**
 * 育成(value)投稿ごとに **ユニークな** AI 画像を生成して R2 に保存し、キーを返す。
 * IG は画像必須かつ同一画像の連投は逆効果なので、投稿本文から毎回作る。生成不可なら null。
 */
export async function generateValuePostImage(
  postId: string,
  body: string,
  deps: GenerateValuePostImageDeps = {},
): Promise<string | null> {
  const log = deps.logger ?? createLogger('worker.promotion.promo-image');
  const uploadBuffer = deps.uploadBuffer ?? defaultUploadBuffer;
  const baseFn: GenerateImageFn = deps.generateImage ?? defaultGenerateImage;
  const genFn = withImageLogging(baseFn, { role: 'promo_image', themeSessionId: `value:${postId}` }, deps.withImageLoggingDeps);

  const result = await genFn({
    prompt: buildValueImagePrompt(body),
    width: 1024,
    height: 1024,
    quality: 'medium',
    outputFormat: 'jpeg',
    outputCompression: 90,
  });
  const image = result.images[0];
  if (!image) {
    log.warn({ postId }, 'value post image generation returned no image');
    return null;
  }
  const key = promotionPostImage(postId);
  await uploadBuffer(key, image, 'image/jpeg');
  log.info({ postId, key }, 'value post image generated');
  return key;
}
