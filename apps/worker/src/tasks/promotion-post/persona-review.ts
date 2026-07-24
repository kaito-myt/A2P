/**
 * 販促投稿のペルソナ×戦略レビュー・ゲート (F-057 品質強化)。
 *
 * マーケターが作ったアカウント戦略(AccountStrategyProfile)と、そこから合成した
 * 読者ロールモデル(ペルソナ)をもとに、content_optimizer で各下書きを評価・改善する。
 * 投稿生成時(promo/value)と日次見直しの両方から使う共有ヘルパ。
 *
 * ガード:
 *  - メタ混入(id/他投稿への言及/運用メモ)した改善は破棄(公開事故防止)。
 *  - kind='promo' で元本文の URL が落ちる改善は破棄(購入導線を守る)。
 */
import { optimizeScheduledPosts as defaultOptimize } from '@a2p/agents';
import { buildAudiencePersona, type AccountStrategyProfile } from '@a2p/contracts/agents';
import type {
  ContentOptimizerInput,
  ContentOptimizerOutput,
} from '@a2p/contracts/agents/content-optimizer';
import type { Logger } from '@a2p/contracts/logger';

export type OptimizeFn = (input: ContentOptimizerInput) => Promise<ContentOptimizerOutput>;

export interface ReviewedDraft {
  /** 採用する本文(改善版 or 元のまま)。 */
  body: string;
  /** 品質スコア(0-100)。取得できなければ null。 */
  score: number | null;
  /** ペルソナ反応/改善理由(非公開・監査用)。 */
  reason: string | null;
  changed: boolean;
}

/** content_pillars を "name: description" の文字列群にする。 */
export function pillarStrings(p: AccountStrategyProfile): string[] {
  return (p.content_pillars ?? [])
    .map((pl) => (pl?.name ? `${pl.name}${pl.description ? `: ${pl.description}` : ''}` : ''))
    .filter((s) => s.trim().length > 0);
}

const META_LEAK_RE = /(公開タイミング|投稿と内容が近い|ご検討ください|重複しています|分散をおすすめ)/;

/**
 * 1 チャンネル分の下書きをペルソナ×戦略でレビュー・改善する。
 * 返り値は id → 採用本文/スコア/理由 の Map(全 draft を必ず含む。失敗時は原文据え置き)。
 */
export async function reviewDraftsWithPersona(args: {
  channel: string;
  profile: AccountStrategyProfile;
  drafts: Array<{ id: string; kind: string; body: string }>;
  bookTargetReader?: string | null;
  recent?: string[];
  playbookGuidance?: string;
  genre?: string | null;
  optimize?: OptimizeFn;
  logger?: Logger;
}): Promise<Map<string, ReviewedDraft>> {
  const optimize = args.optimize ?? ((i: ContentOptimizerInput) => defaultOptimize(i));
  const result = new Map<string, ReviewedDraft>();
  for (const d of args.drafts) result.set(d.id, { body: d.body, score: null, reason: null, changed: false });
  if (args.drafts.length === 0) return result;

  let out: ContentOptimizerOutput;
  try {
    out = await optimize({
      channel: args.channel,
      genre: args.genre ?? null,
      concept: args.profile.concept ?? '',
      tone_of_voice: args.profile.tone_of_voice ?? '',
      content_pillars: pillarStrings(args.profile),
      persona: buildAudiencePersona(args.profile, { bookTargetReader: args.bookTargetReader ?? null }),
      hashtag_core: args.profile.hashtag_strategy?.core ?? [],
      recent_posted: args.recent ?? [],
      drafts: args.drafts.map((d) => ({ id: d.id, kind: d.kind, body: d.body })),
      playbook_guidance: args.playbookGuidance ?? '',
    });
  } catch (err) {
    args.logger?.warn({ channel: args.channel, err }, 'persona review optimize failed — keep original drafts');
    return result;
  }

  const byId = new Map(args.drafts.map((d) => [d.id, d]));
  for (const rev of out.revisions) {
    const orig = byId.get(rev.id);
    if (!orig) continue;
    const slot = result.get(rev.id)!;
    slot.score = Number.isFinite(rev.score) ? Math.round(rev.score) : null;
    slot.reason = (rev.persona_reaction || rev.reason || '').trim() || null;

    const newBody = rev.revised_body.trim();
    if (!rev.changed || newBody.length === 0 || newBody === orig.body.trim()) continue;

    // メタ混入ガード
    const metaLeak =
      /\bid\s*=/.test(newBody) || args.drafts.some((d) => newBody.includes(d.id)) || META_LEAK_RE.test(newBody);
    if (metaLeak) {
      args.logger?.info({ channel: args.channel, postId: rev.id }, 'revision leaked meta — skip');
      continue;
    }
    // promo URL ガード
    if (orig.kind === 'promo') {
      const origUrls = orig.body.match(/https?:\/\/[^\s]+/g) ?? [];
      if (!origUrls.every((u) => newBody.includes(u))) {
        args.logger?.info({ channel: args.channel, postId: rev.id }, 'revision dropped URL — skip');
        continue;
      }
    }
    slot.body = newBody;
    slot.changed = true;
  }
  return result;
}
