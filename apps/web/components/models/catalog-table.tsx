'use client';

/**
 * CatalogTable (S-020) — モデル単価カタログの表示テーブル.
 *
 * 機能:
 *  - 列クリックでソート (provider / model / input / output / fetched_at)
 *  - provider プルダウンでフィルタ (anthropic / openai / google / 全て)
 *  - 各行に編集ボタン → EditCatalogDrawer モーダル
 *  - 前回比 ±% は CatalogTableRow に事前計算済の delta_pct を渡す
 *  - 1 冊予測コスト列は暫定式 (入力 5k tok + 出力 30k tok を USD→JPY 変換)
 *
 * `data-testid` 規約: catalog-table / catalog-row-{provider}-{model}
 */
import { useMemo, useState } from 'react';

import { cn } from '@/lib/cn';
import { messages } from '@/lib/messages';
import { EditCatalogDrawer, type EditCatalogRow } from './edit-catalog-drawer';

/** RSC 側で Decimal → string 化したシリアライズ済みの行。 */
export interface CatalogTableRow {
  id: string;
  provider: string;
  model: string;
  input_price_per_mtok_usd: string;
  output_price_per_mtok_usd: string;
  image_price_per_image_usd: string | null;
  fx_rate_usd_jpy: string;
  fetched_at: string; // ISO 8601
  source: string;
  /** 前回 (旧 is_current=false 行) との変動率 (%) — null = 比較不可。 */
  delta_pct: number | null;
}

interface CatalogTableProps {
  rows: readonly CatalogTableRow[];
}

type SortKey = 'provider' | 'model' | 'input' | 'output' | 'fetched_at';
type SortDir = 'asc' | 'desc';

/** 1 冊予測の暫定モデル: 入力 5k tok + 出力 30k tok (docs/wireframes prompt). */
const PRED_INPUT_TOK = 5_000;
const PRED_OUTPUT_TOK = 30_000;

function num(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function predictPerBookJpy(row: CatalogTableRow): number {
  const inUsdPerMtok = num(row.input_price_per_mtok_usd);
  const outUsdPerMtok = num(row.output_price_per_mtok_usd);
  const fx = num(row.fx_rate_usd_jpy);
  const usd = (inUsdPerMtok * PRED_INPUT_TOK + outUsdPerMtok * PRED_OUTPUT_TOK) / 1_000_000;
  return usd * fx;
}

function formatJpy(v: number): string {
  return `¥${Math.round(v).toLocaleString('ja-JP')}`;
}

function pricePer1k(usdPerMtokStr: string): string {
  const v = num(usdPerMtokStr) / 1000;
  // 4 桁有効数字
  return `$${v.toFixed(4)}`;
}

function formatDelta(pct: number | null, fallbackNoDelta: string, noChange: string): string {
  if (pct === null) return fallbackNoDelta;
  if (pct === 0) return noChange;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

export function CatalogTable({ rows }: CatalogTableProps) {
  const m = messages.modelCatalog;
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('provider');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const providers = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.provider);
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((r) => providerFilter === 'all' || r.provider === providerFilter);
  }, [rows, providerFilter]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const cmp = compareRows(a, b, sortKey);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  if (rows.length === 0) {
    return (
      <div
        data-testid="catalog-table"
        className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center text-body text-muted"
      >
        {m.table.empty}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-space-snug">
      <div className="flex flex-wrap items-center gap-space-snug">
        <label className="flex items-center gap-2 text-button-sm text-charcoal-82">
          {m.filter.provider}:
          <select
            value={providerFilter}
            onChange={(e) => setProviderFilter(e.currentTarget.value)}
            data-testid="catalog-provider-filter"
            className="h-8 rounded-default border border-border-warm bg-cream-light px-2 text-button-sm text-charcoal"
          >
            <option value="all">{m.filter.providerAll}</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {providerLabel(p)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div
        data-testid="catalog-table"
        className="overflow-x-auto rounded-card border border-border-warm"
      >
        <table className="w-full border-collapse text-body">
          <thead className="bg-charcoal-04">
            <tr>
              <SortableTh
                label={m.table.provider}
                active={sortKey === 'provider'}
                dir={sortDir}
                onClick={() => toggleSort('provider')}
              />
              <SortableTh
                label={m.table.model}
                active={sortKey === 'model'}
                dir={sortDir}
                onClick={() => toggleSort('model')}
              />
              <SortableTh
                label={m.table.inputPrice}
                align="right"
                active={sortKey === 'input'}
                dir={sortDir}
                onClick={() => toggleSort('input')}
              />
              <SortableTh
                label={m.table.outputPrice}
                align="right"
                active={sortKey === 'output'}
                dir={sortDir}
                onClick={() => toggleSort('output')}
              />
              <Th align="right">{m.table.perBookCost}</Th>
              <SortableTh
                label={m.table.fetchedAt}
                active={sortKey === 'fetched_at'}
                dir={sortDir}
                onClick={() => toggleSort('fetched_at')}
              />
              <Th>{m.table.source}</Th>
              <Th align="right">{m.table.delta}</Th>
              <Th align="right">{m.table.actions}</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const editRow: EditCatalogRow = {
                id: r.id,
                provider: r.provider,
                model: r.model,
                input_price_per_mtok_usd: r.input_price_per_mtok_usd,
                output_price_per_mtok_usd: r.output_price_per_mtok_usd,
                image_price_per_image_usd: r.image_price_per_image_usd,
              };
              const deltaWarn = r.delta_pct !== null && Math.abs(r.delta_pct) > 10;
              return (
                <tr
                  key={r.id}
                  data-testid={`catalog-row-${r.provider}-${r.model}`}
                  className="border-t border-border-warm"
                >
                  <Td>{providerLabel(r.provider)}</Td>
                  <Td>{r.model}</Td>
                  <Td align="right">{pricePer1k(r.input_price_per_mtok_usd)}</Td>
                  <Td align="right">{pricePer1k(r.output_price_per_mtok_usd)}</Td>
                  <Td align="right">{formatJpy(predictPerBookJpy(r))}</Td>
                  <Td>{formatDateTime(r.fetched_at)}</Td>
                  <Td>{r.source}</Td>
                  <Td align="right">
                    <span className={cn(deltaWarn && 'text-destructive font-medium')}>
                      {formatDelta(r.delta_pct, m.table.noDelta, m.table.noChange)}
                    </span>
                  </Td>
                  <Td align="right">
                    <EditCatalogDrawer row={editRow} />
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="border-t border-border-warm bg-charcoal-03 px-space-relaxed py-2 text-button-sm text-muted">
          {m.perBookAssumptionNote}
        </p>
      </div>
    </div>
  );
}

function providerLabel(p: string): string {
  const m = messages.modelCatalog.providers as Record<string, string>;
  return m[p] ?? p;
}

function compareRows(a: CatalogTableRow, b: CatalogTableRow, key: SortKey): number {
  switch (key) {
    case 'provider':
      return a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
    case 'model':
      return a.model.localeCompare(b.model);
    case 'input':
      return num(a.input_price_per_mtok_usd) - num(b.input_price_per_mtok_usd);
    case 'output':
      return num(a.output_price_per_mtok_usd) - num(b.output_price_per_mtok_usd);
    case 'fetched_at':
      return a.fetched_at.localeCompare(b.fetched_at);
    default:
      return 0;
  }
}

function Th({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      scope="col"
      className={`px-space-relaxed py-2 text-button-sm font-normal text-charcoal-82 ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

function SortableTh({
  label,
  align = 'left',
  active,
  dir,
  onClick,
}: {
  label: string;
  align?: 'left' | 'right';
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <th
      scope="col"
      className={`px-space-relaxed py-2 text-button-sm font-normal text-charcoal-82 ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'inline-flex items-center gap-1 text-button-sm text-charcoal-82',
          'hover:underline focus-visible:outline-none focus-visible:underline',
        )}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <span>{label}</span>
        {active && <span aria-hidden="true">{dir === 'asc' ? '▲' : '▼'}</span>}
      </button>
    </th>
  );
}

function Td({
  children,
  align = 'left',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <td
      className={`px-space-relaxed py-3 text-body align-middle ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </td>
  );
}
