/**
 * F-057 — SNS アカウント戦略担当 (sns_strategist) の I/O 契約。
 *
 * 「投稿の箱」だけでなく「誰が・何を発信するアカウントか」というアカウント設計を担う
 * ランタイムエージェント。接続済みチャンネル 1 つに対して、コンセプト/表示名/bio/
 * アイコン・カバー画像の生成プロンプト/発信の柱/トーン/投稿頻度/ハッシュタグ/グロース戦術
 * までを一括設計する。出力は `promotion_channel_settings.strategy_json` に保存され、
 * 画像は R2 に保存、UI で運営者が確認・適用する。
 *
 * org 層の `account_strategist`（どのニッチ専用アカウントを新設すべきか列挙するバッチ）
 * とは別物。こちらは「既存の 1 アカウントを運用設計する」ランタイム。
 */
import { z } from 'zod';

import { PromotionChannelSchema } from '../promotion/channels.js';

/** 在庫本の要約（ペルソナを実在庫に接地させるための材料）。 */
export const SnsCatalogSnapshotSchema = z.object({
  /** ジャンル→点数（どの切り口に読者がいるか）。 */
  genre_inventory: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** 代表的な書名サンプル。 */
  sample_titles: z.array(z.string().max(200)).max(30).default([]),
  /** 想定ターゲット読者のサンプル。 */
  target_readers: z.array(z.string().max(300)).max(20).default([]),
});
export type SnsCatalogSnapshot = z.infer<typeof SnsCatalogSnapshotSchema>;

export const SnsStrategistInputSchema = z.object({
  channel: PromotionChannelSchema,
  /** 既存の表示ハンドル（あれば踏襲/改善の基点にする）。 */
  current_handle: z.string().max(80).nullable().optional(),
  catalog: SnsCatalogSnapshotSchema,
  /** 運営者からの追加指示（任意）。 */
  instruction: z.string().max(2000).optional(),
});
export type SnsStrategistInput = z.infer<typeof SnsStrategistInputSchema>;

/** 発信の柱（コンテンツピラー）1 本。 */
export const ContentPillarSchema = z.object({
  /** 柱の名前（例: 「明日から使える仕事術」）。 */
  name: z.string().min(1).max(120),
  /** 何を・誰に・どんな価値で発信するか。 */
  description: z.string().max(1000).default(''),
  /** そのままの投稿例（1 本）。 */
  example_post: z.string().max(2000).default(''),
});
export type ContentPillar = z.infer<typeof ContentPillarSchema>;

/** 投稿頻度・時間帯の方針。 */
export const PostingCadenceSchema = z.object({
  /** 頻度（例: 「平日は 1 日 2 投稿、休日 1 投稿」）。 */
  frequency: z.string().min(1).max(600),
  /** 推奨投稿時刻（例: "07:30", "12:15", "21:00"）。 */
  best_times: z.array(z.string().max(120)).max(12).default([]),
});
export type PostingCadence = z.infer<typeof PostingCadenceSchema>;

/** ハッシュタグ方針。文字列は `#` 付きで返させる。 */
export const HashtagStrategySchema = z.object({
  /** 毎回付ける定番タグ。 */
  core: z.array(z.string().max(120)).max(15).default([]),
  /** 話題に応じて回すタグ。 */
  rotating: z.array(z.string().max(120)).max(30).default([]),
});
export type HashtagStrategy = z.infer<typeof HashtagStrategySchema>;

/**
 * アカウント運用プロファイル（1 チャンネル分）。
 * 画像プロンプトは gpt-image-1 に渡す前提で「文字を描かせない」指示込みにする。
 *
 * 注意: 文字数上限/最小数は LLM 出力を弾かないよう緩めに設定する（厳しすぎると
 * generateObject が "response did not match schema" で失敗する）。整形はプロンプト側で誘導。
 */
/** 値を文字列へ寄せる（オブジェクト/配列が来たら代表文字列を拾う）。 */
function coerceToString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const s = Object.values(v as Record<string, unknown>).find((x) => typeof x === 'string');
    return typeof s === 'string' ? s : JSON.stringify(v);
  }
  return v == null ? '' : String(v);
}

/**
 * LLM 出力の“ゆらぎ”を吸収する前処理。posting_cadence を文字列で返す/hashtag_strategy を配列で返す/
 * pillars を文字列配列で返す 等の逸脱を、スキーマ形に正規化する。
 */
function normalizeProfile(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const o: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  if (typeof o.posting_cadence === 'string') {
    o.posting_cadence = { frequency: o.posting_cadence, best_times: [] };
  }
  if (Array.isArray(o.hashtag_strategy)) {
    o.hashtag_strategy = { core: o.hashtag_strategy, rotating: [] };
  } else if (typeof o.hashtag_strategy === 'string') {
    o.hashtag_strategy = { core: [o.hashtag_strategy], rotating: [] };
  }
  if (Array.isArray(o.growth_tactics)) {
    o.growth_tactics = o.growth_tactics.map(coerceToString).filter((s) => s.length > 0);
  }
  if (Array.isArray(o.content_pillars)) {
    o.content_pillars = o.content_pillars.map((p) => {
      if (typeof p === 'string') return { name: p, description: '', example_post: '' };
      return p;
    });
  }
  return o;
}

export const AccountStrategyProfileSchema = z.preprocess(
  normalizeProfile,
  z.object({
    /** ポジショニング宣言（このアカウントは何屋か）。 */
    concept: z.string().min(1).max(2000),
    /** 表示名（プロフィールに出る名前）。 */
    display_name: z.string().min(1).max(120),
    /** 推奨ハンドル（@ なし・英数字/アンダースコア）。 */
    handle_suggestion: z.string().min(1).max(80),
    /** プロフィール文（各媒体の文字数に収める）。 */
    bio: z.string().min(1).max(2000),
    /** 発信の柱（3〜6 本を推奨、最低 1 本）。 */
    content_pillars: z.array(ContentPillarSchema).min(1).max(10),
    /** トーン&マナー（語り口）。 */
    tone_of_voice: z.string().min(1).max(1000),
    posting_cadence: PostingCadenceSchema,
    hashtag_strategy: HashtagStrategySchema,
    /** プラットフォーム別のグロース戦術。 */
    growth_tactics: z.array(z.string().min(1).max(1000)).min(1).max(12),
    /** アイコン（正方形）生成プロンプト。文字なし。 */
    avatar_prompt: z.string().min(1).max(3000),
    /** カバー/ヘッダー（横長）生成プロンプト。文字なし。 */
    banner_prompt: z.string().min(1).max(3000),
    /** 戦略の根拠（任意）。 */
    rationale: z.string().max(2000).optional(),
  }),
);
export type AccountStrategyProfile = z.infer<typeof AccountStrategyProfileSchema>;

/**
 * 読者ロールモデル(ペルソナ)の説明文を戦略プロフィール(＋任意で書籍の想定読者)から
 * 合成する純関数。content_optimizer がこの人物になりきって投稿を評価する。
 * 戦略の concept / tone_of_voice / content_pillars / bio と、書籍の target_reader を素材にする。
 */
export function buildAudiencePersona(
  profile: Partial<Pick<AccountStrategyProfile, 'concept' | 'tone_of_voice' | 'bio' | 'content_pillars'>> | null | undefined,
  opts?: { bookTargetReader?: string | null },
): string {
  const lines: string[] = [];
  const reader = opts?.bookTargetReader?.trim();
  if (reader) lines.push(`- 想定読者像: ${reader}`);
  if (profile?.concept?.trim()) lines.push(`- このアカウントに惹かれる理由(コンセプト): ${profile.concept.trim()}`);
  if (profile?.bio?.trim()) lines.push(`- フォロー時に見えるプロフィール: ${profile.bio.trim()}`);
  const pillars = (profile?.content_pillars ?? [])
    .map((p) => (typeof p === 'string' ? p : p?.name))
    .filter((s): s is string => !!s && s.trim().length > 0);
  if (pillars.length) lines.push(`- 関心のあるテーマ: ${pillars.join(' / ')}`);
  if (profile?.tone_of_voice?.trim()) lines.push(`- 好む語り口/雰囲気: ${profile.tone_of_voice.trim()}`);
  if (lines.length === 0) {
    return 'このジャンルの一般的な読者。SNS を流し見しており、役に立つ・面白い・自分ごとに感じる投稿だけに手を止める。';
  }
  return [
    'あなたはこのアカウントのターゲット読者(フォロワー候補)本人です。次の人物になりきってください:',
    ...lines,
    '- SNS はスキマ時間に流し見。宣伝くさい/テンプレ/誇張は即スルーする。役立つ・共感・意外性のある投稿だけ保存やフォローをする。',
  ].join('\n');
}
