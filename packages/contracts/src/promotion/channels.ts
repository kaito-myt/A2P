/**
 * F-052 — 販促チャンネル自動運用の共有契約。
 *
 * 販促プラン (PromotionPlanOutput) から SNS / note / ブログの投稿ドラフトを
 * 日程付きで機械的に導出し、worker のディスパッチャが期限到来分を各チャンネルへ
 * 自動投稿する。ここには「チャンネル種別」「投稿ステータス」「投稿ドラフト型」と
 * 純粋な導出関数 `buildPromotionPosts` を置く (LLM 呼び出しなし・決定的)。
 */
import { z } from 'zod';

import type { PromotionPlanOutput } from '../agents/promoter.js';

/** 販促チャンネル種別。 */
export const PROMOTION_CHANNELS = ['x', 'instagram', 'tiktok', 'note', 'blog'] as const;
export const PromotionChannelSchema = z.enum(PROMOTION_CHANNELS);
export type PromotionChannel = z.infer<typeof PromotionChannelSchema>;

/** 短文SNS (x_posts を流し込むチャンネル)。 */
export const SHORT_FORM_CHANNELS = ['x', 'instagram', 'tiktok'] as const;
/** ツール所有で「作成〜運用まで完全自律」できるチャンネル (第三者接続不要)。 */
export const OWNED_CHANNELS = ['blog'] as const;

/** 投稿ステータス。 */
export const PROMOTION_POST_STATUSES = [
  'draft', // 生成直後だが日程未確定
  'scheduled', // 予定済 (期限到来で投稿対象)
  'posting', // 投稿処理中
  'posted', // 投稿成功
  'failed', // 投稿失敗
  'skipped', // 条件により送信せずスキップ
  'canceled', // 運営者が取消
] as const;
export const PromotionPostStatusSchema = z.enum(PROMOTION_POST_STATUSES);
export type PromotionPostStatus = z.infer<typeof PromotionPostStatusSchema>;

/** buildPromotionPosts が返す投稿ドラフト 1 件 (DB 挿入前の素材)。 */
export interface PromotionPostDraft {
  channel: PromotionChannel;
  /** note/blog の見出し。SNS は null。 */
  title: string | null;
  /** 投稿本文。 */
  body: string;
  /** baseTime からの相対オフセット (分)。呼び出し側が baseTime に加算して scheduled_for を決める。 */
  offsetMinutes: number;
}

/** buildPromotionPosts のオプション。 */
export interface BuildPromotionPostsOptions {
  /** SNS 投稿を初回から何分間隔で並べるか (既定 1日=1440分)。 */
  snsIntervalMinutes?: number;
  /** SNS 初回投稿の baseTime からのオフセット (既定 0)。 */
  snsFirstOffsetMinutes?: number;
  /** note 記事の baseTime からのオフセット (既定 1日後)。 */
  noteOffsetMinutes?: number;
  /** ブログ記事の baseTime からのオフセット (既定 2日後)。 */
  blogOffsetMinutes?: number;
}

const DAY = 1440;

/**
 * 販促プランから SNS / note / ブログの投稿ドラフトを日程付きで導出する。
 *
 * - SNS: `promo_copy.x_posts[]` を snsInterval 間隔で並べる (launch 週に日次投稿する想定)。
 * - note: `promo_copy.note_article` を 1 本 (見出しは summary 冒頭から生成)。
 * - blog: `promo_copy.blog_outline` を 1 本。
 *
 * 決定的な純関数 (Date に依存しない)。scheduled_for の確定は呼び出し側で
 * `baseTime + offsetMinutes` を計算して行う。
 */
export function buildPromotionPosts(
  plan: Pick<PromotionPlanOutput, 'promo_copy'> & Partial<Pick<PromotionPlanOutput, 'summary'>>,
  options: BuildPromotionPostsOptions = {},
): PromotionPostDraft[] {
  const snsInterval = options.snsIntervalMinutes ?? DAY;
  const snsFirst = options.snsFirstOffsetMinutes ?? 0;
  const noteOffset = options.noteOffsetMinutes ?? DAY;
  const blogOffset = options.blogOffsetMinutes ?? 2 * DAY;

  const drafts: PromotionPostDraft[] = [];
  const copy = plan.promo_copy;

  // 短文SNS: 各 x_post を X / Instagram / TikTok それぞれ 1 投稿に (同一文面をキャプションとして流用)。
  const xPosts = Array.isArray(copy?.x_posts) ? copy.x_posts : [];
  xPosts.forEach((body, i) => {
    const text = typeof body === 'string' ? body.trim() : '';
    if (text.length === 0) return;
    for (const channel of SHORT_FORM_CHANNELS) {
      drafts.push({
        channel,
        title: null,
        body: text,
        offsetMinutes: snsFirst + i * snsInterval,
      });
    }
  });

  // note: 記事 1 本
  const note = typeof copy?.note_article === 'string' ? copy.note_article.trim() : '';
  if (note.length > 0) {
    drafts.push({
      channel: 'note',
      title: deriveTitle(plan.summary, note),
      body: note,
      offsetMinutes: noteOffset,
    });
  }

  // blog: 骨子 1 本
  const blog = typeof copy?.blog_outline === 'string' ? copy.blog_outline.trim() : '';
  if (blog.length > 0) {
    drafts.push({
      channel: 'blog',
      title: deriveTitle(plan.summary, blog),
      body: blog,
      offsetMinutes: blogOffset,
    });
  }

  return drafts;
}

/**
 * docs/06 P4 増分2 — 多アカウント投稿ルーティング。
 * 接続済み(connected)アカウントの中から、この投稿(チャンネル×書籍ジャンル)に使う
 * アカウントを1つ選ぶ。無ければ null（＝チャンネル既定の接続設定にフォールバック）。
 *
 * 選定: 同一チャンネルの connected アカウントのうち、niche が genre と一致する候補を優先し、
 * 無ければ最初の候補。決定的（LLM 非依存）。
 */
export interface RoutableAccount {
  id: string;
  channel: string;
  niche: string;
}

export function pickAccountForChannel(
  channel: string,
  genre: string | null | undefined,
  accounts: readonly RoutableAccount[],
): string | null {
  const candidates = accounts.filter((a) => a.channel === channel);
  if (candidates.length === 0) return null;
  if (genre) {
    const g = genre.toLowerCase();
    const matched = candidates.find((a) => a.niche.toLowerCase().includes(g));
    if (matched) return matched.id;
  }
  return candidates[0]!.id;
}

// ===========================================================================
// X (Twitter) テキスト計量 + Amazon 購入リンク注入
//   X は「重み付き文字数」で 280 まで。ラテン等は 1、日本語(かな/カナ/漢字)は 2。
//   URL は t.co ラップで常に 23。これを踏まえないと日本語ツイートが上限超過で
//   API に弾かれる (例: 日本語 151 字 = 302 > 280)。
// ===========================================================================

export const X_MAX_WEIGHT = 280;
/** X は URL を t.co ラップで一律 23 文字として数える。 */
export const X_URL_WEIGHT = 23;

/** 1 コードポイントの重み (twitter-text の既定レンジに準拠。ラテン/記号=1、他=2)。 */
function charWeight(cp: number): number {
  if (
    (cp >= 0x0000 && cp <= 0x10ff) ||
    (cp >= 0x2000 && cp <= 0x200d) ||
    (cp >= 0x2010 && cp <= 0x201f) ||
    (cp >= 0x2032 && cp <= 0x2037)
  ) {
    return 1;
  }
  return 2;
}

/** X の重み付き文字数 (日本語=2, ラテン=1)。URL は素の文字数で計算するので注意。 */
export function weightedTweetLength(text: string): number {
  let w = 0;
  for (const ch of text) w += charWeight(ch.codePointAt(0)!);
  return w;
}

/** 重み付き文字数が maxWeight を超えないよう末尾を切り詰める (超過時は末尾に「…」)。 */
export function truncateToWeight(text: string, maxWeight: number): string {
  if (weightedTweetLength(text) <= maxWeight) return text;
  const ellipsisWeight = 2; // 「…」
  const budget = Math.max(0, maxWeight - ellipsisWeight);
  let w = 0;
  let out = '';
  for (const ch of text) {
    const cw = charWeight(ch.codePointAt(0)!);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out.trimEnd() + '…';
}

/** ASIN (10 桁英数) から Amazon.co.jp 商品 URL を作る。無効なら null。 */
export function amazonUrlForAsin(asin: string | null | undefined): string | null {
  if (!asin || typeof asin !== 'string') return null;
  const a = asin.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(a)) return null;
  return `https://www.amazon.co.jp/dp/${a}`;
}

const PURCHASE_LABEL = '\n\n▼詳細・購入はこちら\n';

/**
 * 投稿本文に Amazon 購入リンクを付与する (売上導線)。
 *   - asin が無効なら本文そのまま。
 *   - 既に URL / Amazon 表記を含むなら二重付与しない。
 *   - x/instagram/tiktok は X の重み(280, URL=23)に収まるよう本文を切り詰めてから付与。
 *   - note/blog は長文可なのでそのまま付与。
 */
export function appendPurchaseLink(
  channel: string,
  body: string,
  asin: string | null | undefined,
): string {
  const url = amazonUrlForAsin(asin);
  if (!url) return body;
  const trimmedBody = body.trim();
  if (/https?:\/\//i.test(trimmedBody) || /amazon\.|amzn/i.test(trimmedBody)) return trimmedBody;

  // 短文チャンネルは X の重み制約に合わせる (IG/TikTok は余裕があるが X 基準で安全側に)。
  if (channel === 'x' || channel === 'instagram' || channel === 'tiktok') {
    const labelWeight = weightedTweetLength(PURCHASE_LABEL);
    const maxBody = X_MAX_WEIGHT - X_URL_WEIGHT - labelWeight;
    const fitted = truncateToWeight(trimmedBody, maxBody);
    return `${fitted}${PURCHASE_LABEL}${url}`;
  }
  return `${trimmedBody}${PURCHASE_LABEL}${url}`;
}

const URL_RE = /https?:\/\/\S+/g;

/** URL を t.co 相当(23)として数える重み付き文字数 (ハッシュタグ余白計算用)。 */
export function weightedTweetLengthWithUrls(text: string): number {
  let total = 0;
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const idx = m.index ?? 0;
    total += weightedTweetLength(text.slice(last, idx));
    total += X_URL_WEIGHT;
    last = idx + m[0].length;
  }
  total += weightedTweetLength(text.slice(last));
  return total;
}

/**
 * F-057 — 投稿本文の末尾に、アカウント戦略の定番ハッシュタグを付与する。
 *   - 既に本文に含まれるタグは重複付与しない。
 *   - 短文チャンネル(x/instagram/tiktok)は X の重み(280, URL=23)に収まる範囲だけ付与。
 *   - note/blog は全タグを付与。
 * tags は `#` 付き想定 (無ければ補完する)。
 */
export function appendHashtags(
  channel: string,
  body: string,
  tags: readonly string[],
): string {
  const trimmed = body.trimEnd();
  const seen = new Set<string>();
  const candidates = tags
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter((t) => t.length > 0)
    .map((t) => (t.startsWith('#') ? t : `#${t}`))
    .filter((t) => {
      if (seen.has(t) || trimmed.includes(t)) return false;
      seen.add(t);
      return true;
    });
  if (candidates.length === 0) return trimmed;

  const short = channel === 'x' || channel === 'instagram' || channel === 'tiktok';
  if (!short) {
    return `${trimmed}\n\n${candidates.join(' ')}`;
  }

  // 短文: 上限(280 重み)に収まるタグだけ足す。先頭は改行2つ(重み2)、以降はスペース(重み1)。
  const baseWeight = weightedTweetLengthWithUrls(trimmed);
  const accepted: string[] = [];
  let extra = 0;
  for (const t of candidates) {
    const sepWeight = accepted.length === 0 ? 2 : 1;
    const tagWeight = weightedTweetLength(t);
    if (baseWeight + extra + sepWeight + tagWeight > X_MAX_WEIGHT) break;
    accepted.push(t);
    extra += sepWeight + tagWeight;
  }
  if (accepted.length === 0) return trimmed;
  return `${trimmed}\n\n${accepted.join(' ')}`;
}

/** 記事見出しを summary / 本文の先頭行から決める (最大 60 字)。 */
function deriveTitle(summary: string | undefined, body: string): string {
  const firstLine = (s: string): string => {
    for (const raw of s.split('\n')) {
      const line = raw.replace(/^#+\s*/, '').trim();
      if (line.length > 0) return line;
    }
    return '';
  };
  const candidate = firstLine(body) || firstLine(summary ?? '') || '新刊のお知らせ';
  return candidate.slice(0, 60);
}
