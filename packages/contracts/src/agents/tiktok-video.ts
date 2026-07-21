/**
 * F-060 — TikTok スライド動画の台本契約と多エージェント IO。
 *
 * 「思わず続きを見たくなる（射幸心を煽る）」縦型スライド動画を、複数エージェントの
 * 役割分担で作る:
 *   scenario(構成台本) → creator(絵コンテ/画像プロンプト) → editor(尺/テロップ/カット) →
 *   proofreader(校閲) → marketer(フック/CTA/ハッシュタグ最終確認)。
 *
 * 出力 VideoScript を worker がレンダリング(画像+テロップ+TTS+ffmpeg → 9:16 mp4)する。
 */
import { z } from 'zod';

import { PromotionChannelSchema } from '../promotion/channels.js';

// ---------------------------------------------------------------------------
// 入力
// ---------------------------------------------------------------------------

export const TikTokVideoInputSchema = z.object({
  channel: PromotionChannelSchema.default('tiktok'),
  /** アカウントのコンセプト（sns_strategist 由来）。 */
  concept: z.string().max(2000).default(''),
  /** トーン&マナー。 */
  tone_of_voice: z.string().max(1000).default(''),
  /** ネタの軸（発信の柱の name など）。 */
  topic: z.string().min(1).max(200),
  /** 世界観の材料（書名など・売り込みには使わない）。 */
  sample_titles: z.array(z.string().max(200)).max(15).default([]),
  /** 宣伝に紐づく本がある場合の情報（value 投稿なら省略）。 */
  book: z
    .object({
      title: z.string().max(200),
      hook: z.string().max(400).optional(),
      asin: z.string().max(20).nullable().optional(),
    })
    .optional(),
  /** 定番ハッシュタグ（core）。 */
  core_hashtags: z.array(z.string().max(80)).max(15).default([]),
  /** 目標尺（秒）。既定 30。 */
  target_seconds: z.number().int().min(10).max(90).default(30),
});
export type TikTokVideoInput = z.infer<typeof TikTokVideoInputSchema>;

// ---------------------------------------------------------------------------
// 中間: シナリオ（構成台本）
// ---------------------------------------------------------------------------

/** シナリオライターが出す構成台本の 1 ビート。 */
export const ScriptBeatSchema = z.object({
  /** そのビートの役割（例: hook/tease/reveal/turn/cliffhanger/cta）。 */
  role: z.string().min(1).max(40),
  /** 語り（ナレーション）。 */
  narration: z.string().min(1).max(400),
});
export type ScriptBeat = z.infer<typeof ScriptBeatSchema>;

export const VideoScenarioSchema = z.object({
  /** 冒頭2秒で心を掴む強フック（続きが気になる問い/断言/意外性）。 */
  hook: z.string().min(1).max(200),
  /** 構成ビート（hook→小出し→引き→CTA の射幸的な流れ）。 */
  beats: z.array(ScriptBeatSchema).min(2).max(10),
  /** 最後まで見せず「続きは？」と思わせる引き（クリフハンガー）。 */
  cliffhanger: z.string().min(1).max(200),
});
export type VideoScenario = z.infer<typeof VideoScenarioSchema>;

// ---------------------------------------------------------------------------
// 最終: VideoScript（レンダリング入力）
// ---------------------------------------------------------------------------

/** 1 シーン（1 枚のスライド）。 */
export const VideoSceneSchema = z.object({
  /** ナレーション（TTS で読み上げる文）。 */
  narration: z.string().min(1).max(400),
  /** 画面に焼き込むテロップ（短く・強く。ナレーションの要約や煽り）。 */
  caption: z.string().min(1).max(60),
  /** 背景画像の生成プロンプト（文字は描かせない）。 */
  image_prompt: z.string().min(1).max(1000),
  /** このシーンの表示秒数。 */
  seconds: z.number().min(1).max(15),
});
export type VideoScene = z.infer<typeof VideoSceneSchema>;

export const VideoScriptSchema = z.object({
  /** 動画タイトル（内部管理用・投稿には使わない）。 */
  title: z.string().min(1).max(120),
  /** シーン列（先頭が最強フック）。 */
  scenes: z.array(VideoSceneSchema).min(2).max(12),
  /** TikTok キャプション（投稿本文。射幸心を煽る一文＋CTA）。 */
  caption: z.string().min(1).max(2200),
  /** ハッシュタグ（# 付き）。 */
  hashtags: z.array(z.string().max(80)).max(15).default([]),
});
export type VideoScript = z.infer<typeof VideoScriptSchema>;

// ---------------------------------------------------------------------------
// 各エージェントの中間出力（editor が VideoScript を確定、以降は改善）
// ---------------------------------------------------------------------------

/** creator: 各ビートに画像プロンプトとテロップ案を付ける。 */
export const StoryboardSceneSchema = z.object({
  narration: z.string().min(1).max(400),
  caption: z.string().min(1).max(60),
  image_prompt: z.string().min(1).max(1000),
});
export type StoryboardScene = z.infer<typeof StoryboardSceneSchema>;

export const StoryboardSchema = z.object({
  scenes: z.array(StoryboardSceneSchema).min(2).max(12),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;
