/**
 * PriceChangeHistory (S-020 セクション 4) — 過去 30 日の単価変動アラート一覧.
 *
 * RSC として描画。Alert.payload_json は catalog.fetch (T-02-09) が以下の形で
 * INSERT する (apps/worker/src/tasks/catalog-fetch.ts:442-457 と 1:1 で一致):
 *
 *   {
 *     provider: string,
 *     model: string,
 *     before: { input_price_per_mtok_usd: number, output_price_per_mtok_usd: number },
 *     after:  { input_price_per_mtok_usd: number, output_price_per_mtok_usd: number },
 *     delta_pct: { input: number, output: number } // 既に % 値 (例: 15.2)
 *   }
 *
 * 表示する delta は input/output のうち |値| が大きい方 (代表値) — catalog-table の
 * ±10% 警告ロジックが代表値判定なので、それと同じ基準で揃える。zod で safeParse
 * し、不一致時のみ '—' フォールバック。
 */
import { z } from 'zod';

import type { Alert } from '@a2p/db';

import { messages } from '@/lib/messages';

const priceSideSchema = z.object({
  input_price_per_mtok_usd: z.number().finite(),
  output_price_per_mtok_usd: z.number().finite(),
});

const priceChangePayloadSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  before: priceSideSchema,
  after: priceSideSchema,
  delta_pct: z.object({
    input: z.number().finite(),
    output: z.number().finite(),
  }),
});

export type PriceChangePayload = z.infer<typeof priceChangePayloadSchema>;

interface PriceChangeHistoryProps {
  alerts: readonly Alert[];
}

export interface ParsedAlertRow {
  id: string;
  occurredAt: string;
  provider: string;
  model: string;
  beforeText: string;
  afterText: string;
  /** 代表値 (|input| と |output| のうち絶対値が大きい方、既に %)。不正 payload は null。 */
  deltaPct: number | null;
  kindLabel: string;
}

export function PriceChangeHistory({ alerts }: PriceChangeHistoryProps) {
  const m = messages.modelCatalog.history;

  const parsed: ParsedAlertRow[] = alerts.map(parseAlert);

  return (
    <section
      data-testid="price-change-history"
      aria-labelledby="price-change-history-heading"
      className="flex flex-col gap-space-snug"
    >
      <h2 id="price-change-history-heading" className="text-card-title text-foreground">
        {m.title}
      </h2>

      {parsed.length === 0 ? (
        <div className="rounded-card border border-border-warm bg-cream-light p-space-loose text-center text-body text-muted">
          {m.empty}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border-warm">
          <table className="w-full border-collapse text-body">
            <thead className="bg-charcoal-04">
              <tr>
                <Th>{m.occurredAt}</Th>
                <Th>{m.provider}</Th>
                <Th>{m.model}</Th>
                <Th>{m.before}</Th>
                <Th>{m.after}</Th>
                <Th align="right">{m.deltaPct}</Th>
                <Th>{m.kindLabel}</Th>
              </tr>
            </thead>
            <tbody>
              {parsed.map((p) => (
                <tr key={p.id} className="border-t border-border-warm">
                  <Td>{p.occurredAt}</Td>
                  <Td>{p.provider}</Td>
                  <Td>{p.model}</Td>
                  <Td>{p.beforeText}</Td>
                  <Td>{p.afterText}</Td>
                  <Td align="right">
                    {p.deltaPct === null
                      ? '—'
                      : `${p.deltaPct > 0 ? '+' : ''}${p.deltaPct.toFixed(1)}%`}
                  </Td>
                  <Td>{p.kindLabel}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function parseAlert(a: Alert): ParsedAlertRow {
  const parsed = priceChangePayloadSchema.safeParse(a.payload_json);
  if (!parsed.success) {
    return {
      id: a.id,
      occurredAt: formatDateTime(a.created_at),
      provider: '—',
      model: '—',
      beforeText: '—',
      afterText: '—',
      deltaPct: null,
      kindLabel: a.kind,
    };
  }
  const p = parsed.data;
  const deltaIn = p.delta_pct.input;
  const deltaOut = p.delta_pct.output;
  const repDelta = Math.abs(deltaIn) >= Math.abs(deltaOut) ? deltaIn : deltaOut;
  return {
    id: a.id,
    occurredAt: formatDateTime(a.created_at),
    provider: p.provider,
    model: p.model,
    beforeText: priceTuple(p.before),
    afterText: priceTuple(p.after),
    deltaPct: repDelta,
    kindLabel: a.kind,
  };
}

function priceTuple(o: { input_price_per_mtok_usd: number; output_price_per_mtok_usd: number }): string {
  return `in ${formatPrice(o.input_price_per_mtok_usd)} / out ${formatPrice(o.output_price_per_mtok_usd)}`;
}

function formatPrice(v: number): string {
  return `$${v.toFixed(4)}`;
}

function formatDateTime(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
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
