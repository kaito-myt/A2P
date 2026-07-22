/**
 * ジャンルカタログ — テーマ生成で選べる書籍ジャンルの単一の真実源 (single source of truth)。
 *
 * これまで genre は `['practical','business','self_help']` の 3 値 enum として
 * contracts / worker / web に散在していた。実運用で「投資」「副業」「健康」「公営競技」など
 * より多様なジャンルを扱いたいという要件 (F-001 拡張) に対応するため、ここに一元化する。
 *
 * 設計方針:
 *  - `slug` は DB `theme_candidates.genre` (自由 String 列) に保存される安定キー。
 *    既存行との互換のため practical/business/self_help の slug は変更しない。
 *  - `label` は UI 表示 + LLM プロンプト注入に使う日本語名。
 *  - `group` は UI の <optgroup> 見出し。
 *  - genre は「プロンプト/モデルの選定キー」でもあるが、未定義ジャンルは
 *    `loadActivePrompt`/`loadModelAssignment` が `OR:[{genre},{genre:null}]` で
 *    role 既定 (genre=null) にフォールバックするため、専用プロンプトが無くても動作する。
 *
 * DB マイグレーション不要 (genre は既に String 列)。
 */
import { z } from 'zod';

export interface GenreDef {
  /** DB 保存キー / プロンプト選定キー。安定・不変。 */
  slug: string;
  /** UI + プロンプト用の日本語ラベル。 */
  label: string;
  /** UI の <optgroup> 見出し。 */
  group: string;
}

export const GENRE_CATALOG: readonly GenreDef[] = [
  // ── ビジネス・キャリア ──
  { slug: 'business', label: 'ビジネス書', group: 'ビジネス・キャリア' },
  { slug: 'money', label: '投資・資産運用', group: 'ビジネス・キャリア' },
  { slug: 'money_saving', label: '節約・家計管理', group: 'ビジネス・キャリア' },
  { slug: 'side_business', label: '副業・起業', group: 'ビジネス・キャリア' },
  { slug: 'career', label: '転職・キャリア', group: 'ビジネス・キャリア' },
  { slug: 'marketing', label: 'マーケティング・SNS運用', group: 'ビジネス・キャリア' },
  // ── 自己啓発・メンタル ──
  { slug: 'self_help', label: '自己啓発', group: '自己啓発・メンタル' },
  { slug: 'mental', label: 'メンタル・心の健康', group: '自己啓発・メンタル' },
  { slug: 'communication', label: '話し方・コミュニケーション', group: '自己啓発・メンタル' },
  { slug: 'relationship', label: '人間関係・恋愛', group: '自己啓発・メンタル' },
  { slug: 'habit', label: '習慣・目標達成', group: '自己啓発・メンタル' },
  // ── 実用・暮らし ──
  { slug: 'practical', label: '実用書', group: '実用・暮らし' },
  { slug: 'health', label: '健康・医療', group: '実用・暮らし' },
  { slug: 'diet', label: 'ダイエット・フィットネス', group: '実用・暮らし' },
  { slug: 'cooking', label: '料理・レシピ', group: '実用・暮らし' },
  { slug: 'lifestyle', label: '暮らし・ライフスタイル', group: '実用・暮らし' },
  { slug: 'parenting', label: '子育て・教育', group: '実用・暮らし' },
  { slug: 'beauty', label: '美容・ファッション', group: '実用・暮らし' },
  { slug: 'pet', label: 'ペット・動物', group: '実用・暮らし' },
  // ── 学び・スキル ──
  { slug: 'study', label: '勉強法・資格', group: '学び・スキル' },
  { slug: 'language', label: '語学・英語', group: '学び・スキル' },
  { slug: 'writing', label: '文章術・ライティング', group: '学び・スキル' },
  { slug: 'it_web', label: 'IT・Web・プログラミング', group: '学び・スキル' },
  { slug: 'ai_tech', label: 'AI・最新テクノロジー', group: '学び・スキル' },
  // ── 趣味・エンタメ ──
  { slug: 'hobby', label: '趣味・娯楽', group: '趣味・エンタメ' },
  { slug: 'gambling', label: '公営競技・馬券', group: '趣味・エンタメ' },
  { slug: 'travel', label: '旅行・お出かけ', group: '趣味・エンタメ' },
  { slug: 'spiritual', label: 'スピリチュアル・占い', group: '趣味・エンタメ' },
  { slug: 'history', label: '歴史・教養', group: '趣味・エンタメ' },
] as const;

/** 全ジャンル slug の配列 (worker の許可セット / zod enum の生成元)。 */
export const GENRE_SLUGS: readonly string[] = GENRE_CATALOG.map((g) => g.slug);

/** slug → 日本語ラベルの逆引きレコード。 */
export const GENRE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(
  GENRE_CATALOG.map((g) => [g.slug, g.label]),
);

/** UI の <optgroup> 用に group ごとにまとめたビュー。 */
export const GENRE_GROUPS: ReadonlyArray<{ group: string; items: readonly GenreDef[] }> =
  (() => {
    const order: string[] = [];
    const byGroup = new Map<string, GenreDef[]>();
    for (const g of GENRE_CATALOG) {
      if (!byGroup.has(g.group)) {
        byGroup.set(g.group, []);
        order.push(g.group);
      }
      byGroup.get(g.group)!.push(g);
    }
    return order.map((group) => ({ group, items: byGroup.get(group)! }));
  })();

/**
 * slug → 日本語ラベル。未知の slug は slug 自身を返す (素通し)。null/undefined は null。
 * 表示 (formatGenre) と LLM プロンプト注入の両方で使う。
 */
export function genreLabel(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return GENRE_LABELS[slug] ?? slug;
}

/** 既知ジャンル slug か。worker の正規化 (未知→null) 判定に使う。 */
export function isKnownGenre(slug: string | null | undefined): boolean {
  return !!slug && Object.prototype.hasOwnProperty.call(GENRE_LABELS, slug);
}

/**
 * テーマ生成入力の境界検証用 — カタログに載る slug のみ許可。
 * (agent I/O 契約側は自由 String を許容: 既存 DB 行や将来ジャンルを弾かないため。)
 */
export const GenreSlugSchema = z.enum(
  GENRE_SLUGS as [string, ...string[]],
);

/**
 * agent I/O 契約用の緩い genre schema。カタログ外の値 (既存行/移行期) も通す。
 * genre は下流では主にプロンプト文脈 + プロンプト/モデル選定キーであり、
 * 未知値は role 既定にフォールバックするため、ここで弾く必要はない。
 */
export const GenreValueSchema = z.string().min(1).max(64);
