/**
 * S-019 マトリクス表示用のシリアライズ済みデータ構築 (T-02-11).
 *
 * RSC (page.tsx) で Prisma の Decimal / Date を文字列に変換し、Client Component
 * (AssignmentMatrix) に渡すための pure ヘルパ。マトリクス座標 [role x genreSlot]
 * の生成と「カタログから単価を引いて表示文字列を組む」処理を集約する。
 *
 * pure 関数として export し Vitest で直接ユニットテスト可能にする。
 */

export const MATRIX_ROLES = [
  'writer',
  'editor',
  'marketer',
  'judge',
  'thumbnail_text',
  'thumbnail_image',
  'optimizer',
] as const;
export type MatrixRole = (typeof MATRIX_ROLES)[number];

/**
 * マトリクス横軸: default (genre=null), practical, business, self_help.
 * UI 上は `default` 列が genre=null に対応する (load-model-assignment と整合)。
 */
export const MATRIX_GENRE_SLOTS = ['default', 'practical', 'business', 'self_help'] as const;
export type MatrixGenreSlot = (typeof MATRIX_GENRE_SLOTS)[number];

export function genreSlotToDbValue(slot: MatrixGenreSlot): string | null {
  return slot === 'default' ? null : slot;
}

export function dbGenreToSlot(genre: string | null): MatrixGenreSlot | null {
  if (genre === null) return 'default';
  if (genre === 'practical' || genre === 'business' || genre === 'self_help') return genre;
  return null;
}

/** Page 側で Prisma → 文字列化したシリアライズ済み割当行。 */
export interface AssignmentRowSerialized {
  id: string;
  role: string;
  genre: string | null;
  provider: string;
  model: string;
  status: string; // active | archived
  activated_at: string; // ISO
  archived_at: string | null; // ISO or null
  created_by: string;
}

/** Page 側で Prisma → 文字列化したカタログ行 (現行版のみ)。 */
export interface CatalogRowSerialized {
  id: string;
  provider: string;
  model: string;
  input_price_per_mtok_usd: string;
  output_price_per_mtok_usd: string;
  fx_rate_usd_jpy: string;
}

/** マトリクス 1 セルの表示用データ。 */
export interface MatrixCell {
  role: MatrixRole;
  genreSlot: MatrixGenreSlot;
  /** 該当 active 行 (なければ null = "未設定")。 */
  assignment: AssignmentRowSerialized | null;
  /** カタログ突合済みの単価文字列。assignment があれば必ず引いた値、なければ null。 */
  inputPriceLabel: string | null; // 例: "$15.0000" (USD per Mtok)
  outputPriceLabel: string | null;
  /** assignment があるが catalog に対応行がない場合 true (異常状態の警告用)。 */
  catalogMissing: boolean;
}

function fmtUsdPerMtok(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return `$${n.toFixed(4)}`;
}

/**
 * 役割×ジャンルスロットの 2 次元マトリクスを構築する。
 * - active な assignments のみ使う (archived は履歴側で表示)
 * - catalog はキー (provider+model) でハッシュ化して O(1) で引く
 */
export function buildAssignmentMatrix(
  activeAssignments: readonly AssignmentRowSerialized[],
  currentCatalog: readonly CatalogRowSerialized[],
): MatrixCell[][] {
  const byKey = new Map<string, AssignmentRowSerialized>();
  for (const a of activeAssignments) {
    if (a.status !== 'active') continue;
    const slot = dbGenreToSlot(a.genre);
    if (slot === null) continue; // 知らない genre 値はマトリクスに出さない
    if (!MATRIX_ROLES.includes(a.role as MatrixRole)) continue;
    byKey.set(`${a.role}/${slot}`, a);
  }

  const catalogByKey = new Map<string, CatalogRowSerialized>();
  for (const c of currentCatalog) {
    catalogByKey.set(`${c.provider}/${c.model}`, c);
  }

  return MATRIX_ROLES.map((role) =>
    MATRIX_GENRE_SLOTS.map((genreSlot): MatrixCell => {
      const assignment = byKey.get(`${role}/${genreSlot}`) ?? null;
      if (!assignment) {
        return {
          role,
          genreSlot,
          assignment: null,
          inputPriceLabel: null,
          outputPriceLabel: null,
          catalogMissing: false,
        };
      }
      const catalog = catalogByKey.get(`${assignment.provider}/${assignment.model}`);
      if (!catalog) {
        return {
          role,
          genreSlot,
          assignment,
          inputPriceLabel: null,
          outputPriceLabel: null,
          catalogMissing: true,
        };
      }
      return {
        role,
        genreSlot,
        assignment,
        inputPriceLabel: fmtUsdPerMtok(catalog.input_price_per_mtok_usd),
        outputPriceLabel: fmtUsdPerMtok(catalog.output_price_per_mtok_usd),
        catalogMissing: false,
      };
    }),
  );
}

/** SidePane (現行カタログ一覧) の 1 行分の表示用データ。 */
export interface SidePaneRow {
  id: string;
  provider: string;
  model: string;
  inputPriceLabel: string; // 例: "$15.0000"
  outputPriceLabel: string;
}

/**
 * SidePane 用に現行カタログ行を (provider asc, model asc) で並び替え、
 * 単価を表示文字列にフォーマットする。pure 関数として export。
 */
export function buildSidePaneRows(
  rows: readonly CatalogRowSerialized[],
): SidePaneRow[] {
  return [...rows]
    .sort((a, b) => {
      const p = a.provider.localeCompare(b.provider);
      return p !== 0 ? p : a.model.localeCompare(b.model);
    })
    .map((r) => ({
      id: r.id,
      provider: r.provider,
      model: r.model,
      inputPriceLabel: fmtUsdPerMtok(r.input_price_per_mtok_usd),
      outputPriceLabel: fmtUsdPerMtok(r.output_price_per_mtok_usd),
    }));
}

/** カタログ行を provider でグルーピングして UI のセレクトボックスに供給する。 */
export function groupCatalogByProvider(
  rows: readonly CatalogRowSerialized[],
): Map<string, CatalogRowSerialized[]> {
  const map = new Map<string, CatalogRowSerialized[]>();
  for (const r of rows) {
    const arr = map.get(r.provider);
    if (arr) arr.push(r);
    else map.set(r.provider, [r]);
  }
  // 各グループ内 model 名で安定ソート
  for (const arr of map.values()) {
    arr.sort((a, b) => a.model.localeCompare(b.model));
  }
  return map;
}
