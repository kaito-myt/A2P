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
  name: z.string().min(1).max(40),
  /** 何を・誰に・どんな価値で発信するか。 */
  description: z.string().min(1).max(300),
  /** そのままの投稿例（1 本）。 */
  example_post: z.string().min(1).max(400),
});
export type ContentPillar = z.infer<typeof ContentPillarSchema>;

/** 投稿頻度・時間帯の方針。 */
export const PostingCadenceSchema = z.object({
  /** 頻度（例: 「平日は 1 日 2 投稿、休日 1 投稿」）。 */
  frequency: z.string().min(1).max(160),
  /** 推奨投稿時刻（例: "07:30", "12:15", "21:00"）。 */
  best_times: z.array(z.string().max(40)).max(6).default([]),
});
export type PostingCadence = z.infer<typeof PostingCadenceSchema>;

/** ハッシュタグ方針。文字列は `#` 付きで返させる。 */
export const HashtagStrategySchema = z.object({
  /** 毎回付ける定番タグ。 */
  core: z.array(z.string().max(40)).max(8).default([]),
  /** 話題に応じて回すタグ。 */
  rotating: z.array(z.string().max(40)).max(12).default([]),
});
export type HashtagStrategy = z.infer<typeof HashtagStrategySchema>;

/**
 * アカウント運用プロファイル（1 チャンネル分）。
 * 画像プロンプトは gpt-image-1 に渡す前提で「文字を描かせない」指示込みにする。
 */
export const AccountStrategyProfileSchema = z.object({
  /** ポジショニング宣言（このアカウントは何屋か）。 */
  concept: z.string().min(1).max(600),
  /** 表示名（プロフィールに出る名前）。 */
  display_name: z.string().min(1).max(50),
  /** 推奨ハンドル（@ なし・英数字/アンダースコア）。 */
  handle_suggestion: z.string().min(1).max(30),
  /** プロフィール文（各媒体の文字数に収める）。 */
  bio: z.string().min(1).max(600),
  /** 発信の柱 3〜6 本。 */
  content_pillars: z.array(ContentPillarSchema).min(3).max(6),
  /** トーン&マナー（語り口）。 */
  tone_of_voice: z.string().min(1).max(300),
  posting_cadence: PostingCadenceSchema,
  hashtag_strategy: HashtagStrategySchema,
  /** プラットフォーム別のグロース戦術。 */
  growth_tactics: z.array(z.string().min(1).max(300)).min(2).max(8),
  /** アイコン（正方形）生成プロンプト。文字なし。 */
  avatar_prompt: z.string().min(1).max(1000),
  /** カバー/ヘッダー（横長）生成プロンプト。文字なし。 */
  banner_prompt: z.string().min(1).max(1000),
  /** 戦略の根拠（任意）。 */
  rationale: z.string().max(800).optional(),
});
export type AccountStrategyProfile = z.infer<typeof AccountStrategyProfileSchema>;
