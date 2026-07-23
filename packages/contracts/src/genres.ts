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

// ---------------------------------------------------------------------------
// ジャンル方針 (genre policy) — 実行時にプロンプトへ注入する「ジャンル別の書き方指針」。
//
// 設計: ジャンルは 29 種に増えたが、役割ごとに「全文プロンプト × ジャンル」を用意すると
// 管理不能になる。そこで **役割プロンプトは 1 本 (genre=null 既定)** に集約し、その中の
// `{genre_guidance}` プレースホルダへ、本の genre に応じた方針をここから注入する
// (prompt-loader が差し込む)。ジャンル追加＝ここに 1 行足すだけで全役割に効く。
// ---------------------------------------------------------------------------

/** slug → ジャンル別の書き方方針 (1〜2 文)。未知/ null は汎用方針にフォールバック。 */
export const GENRE_POLICIES: Readonly<Record<string, string>> = {
  business:
    'フレームワーク・データ・事例で説得力を持たせ、意思決定や成果に直結する示唆を与える。',
  money:
    '根拠とリスクを必ず明示し、利回りや儲けの断定・保証はしない。再現可能な考え方と手順を具体的に示す。',
  money_saving:
    '今日から削れる固定費・具体的な手順・金額感を示す。ムリなく続く仕組み化を重視する。',
  side_business:
    '初期費用・収益化までの現実的なステップと落とし穴を、数字を交えて具体的に示す。',
  career:
    '選択肢の比較軸と行動手順を明確にし、市場価値の高め方を具体的に示す。不安を煽らない。',
  marketing:
    '型・事例・数値で語り、すぐ試せる施策と見るべき指標 (KPI) をセットで示す。',
  self_help:
    '読者の感情に寄り添い、行動変容を促す。押し付けず、小さな一歩を具体的に提案する。',
  mental:
    '安心感を与え否定しない。医療の代替と誤解させず、必要時は専門機関の受診目安を添える。',
  communication:
    '場面別の言い換え・例文・型を示し、今日の会話でそのまま使える具体性を持たせる。',
  relationship:
    '具体的な場面と言動例で示す。決めつけず、読者の状況に寄り添う。',
  habit:
    '仕組み化・トリガー・記録など、挫折しない設計を具体的に示す。',
  practical:
    '読者が「今日から実践できる」具体的手順・チェックリスト・テンプレを重視し、抽象論を避ける。',
  health:
    '一般的な知見に基づき、治療効果の保証や断定をしない。受診の目安を添え、安全を最優先する。',
  diet:
    '続けられる方法と具体メニューを示す。極端・危険な方法や効果保証はしない。',
  cooking:
    '分量・手順・時間を明確にし、作りやすさと再現性を担保する。',
  lifestyle:
    '具体的な工夫と before/after を示し、等身大で真似しやすくする。',
  parenting:
    '年齢・場面別に具体的に示す。不安を煽らず、唯一の正解を押し付けない。',
  beauty:
    '具体的な手順・アイテム例を示す。効果保証や過度な断定を避ける。',
  pet:
    '具体的なケアと安全策を示す。健康面は獣医受診の目安を添える。',
  study:
    '手順・スケジュール・教材選びを、再現できる形で数字とともに示す。',
  language:
    '具体フレーズ・練習法・つまずき対策を示し、今日から使える例文を添える。',
  writing:
    '型と、悪文改善の before/after、チェックリストで、すぐ使える技術を示す。',
  it_web:
    '手順とコード/画面例を示す。前提知識を補い、つまずきどころを先回りする。',
  ai_tech:
    '最新かつ正確に。誇張せず、具体的な使い方やプロンプト例など実践できる中身を示す。',
  hobby:
    '初心者がつまずく点を先回りし、道具・手順・楽しみ方を具体的に示す。',
  gambling:
    '期待値・資金管理・データの見方を冷静に示す。射幸心を煽らず、勝ちを保証しない。',
  travel:
    'モデルコース・費用・所要時間・持ち物を具体的に示す。季節や予約の勘所も添える。',
  spiritual:
    '娯楽・内省として提示する。断定・不安商法や、医療/投資の判断への誘導はしない。',
  history:
    '史実に忠実に、通説と諸説を区別する。読み物として面白く、かつ正確に書く。',
};

/** 汎用 (ジャンル未指定/未知) の方針。 */
export const GENERIC_GENRE_POLICY =
  '対象ジャンルはユーザーメッセージで指定される。読者の課題解決を最優先し、具体性と再現性を担保する。';

/**
 * プロンプトの `{genre_guidance}` に注入する 1 行を返す。
 * 例: 「【ジャンル方針：投資・資産運用】根拠とリスクを必ず明示し…」
 * null / 未知 slug は汎用方針にフォールバックする。
 */
export function genreGuidance(slug: string | null | undefined): string {
  if (!slug) return `【ジャンル方針：汎用】${GENERIC_GENRE_POLICY}`;
  const policy = GENRE_POLICIES[slug];
  const label = GENRE_LABELS[slug] ?? slug;
  if (!policy) return `【ジャンル方針：${label}】${GENERIC_GENRE_POLICY}`;
  return `【ジャンル方針：${label}】${policy}`;
}
