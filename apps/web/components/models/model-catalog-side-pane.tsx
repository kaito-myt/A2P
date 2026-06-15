/**
 * ModelCatalogSidePane (S-019) — マトリクス右側に常設する現行カタログ一覧.
 *
 * docs/04 §4 S-019 主要コンテンツセクション 2、SP-02 T-02-11 §4 詳細で要求される
 * パネル。`ModelCatalog (is_current=true)` の全行を provider / model / 入出力単価
 * の 4 列で表示する。Server Component (RSC) として親 page.tsx から呼ぶ。
 *
 * レイアウト:
 *   - 画面 md 以上: 右側 sticky の独立カラム (page 側で grid を組む前提)
 *   - 画面 md 未満: マトリクスの下に折りたたみ表示 (single column)
 *
 * e2e から検証可能にするため、ルートに `data-testid="model-catalog-side-pane"`、
 * 各行に `data-testid="model-catalog-side-pane-row-{provider}-{model}"` を付与。
 *
 * 注意: ドラッグ&ドロップ (wireframe 由来の発展機能) は SP-03 以降。本コンポは
 * 一覧表示のみ。
 */
import { messages } from '@/lib/messages';
import {
  buildSidePaneRows,
  type CatalogRowSerialized,
} from '@/lib/model-assignments-view';

interface Props {
  catalog: readonly CatalogRowSerialized[];
}

export function ModelCatalogSidePane({ catalog }: Props) {
  const m = messages.modelAssignments;
  const mp = messages.modelAssignments.providers as Record<string, string>;
  const rows = buildSidePaneRows(catalog);

  return (
    <aside
      data-testid="model-catalog-side-pane"
      className="md:sticky md:top-space-loose md:self-start flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-snug"
    >
      <header className="flex flex-col">
        <h2 className="text-card-title text-foreground">{m.sidePane.title}</h2>
        <p className="text-button-sm text-muted">{m.sidePane.hint}</p>
      </header>

      {rows.length === 0 ? (
        <p className="text-button-sm text-muted">{m.sidePane.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-button-sm">
            <thead className="bg-charcoal-04">
              <tr>
                <th
                  scope="col"
                  className="px-2 py-1 text-left font-normal text-charcoal-82"
                >
                  {m.sidePane.colProvider}
                </th>
                <th
                  scope="col"
                  className="px-2 py-1 text-left font-normal text-charcoal-82"
                >
                  {m.sidePane.colModel}
                </th>
                <th
                  scope="col"
                  className="px-2 py-1 text-right font-normal text-charcoal-82"
                >
                  {m.sidePane.colInputPrice}
                </th>
                <th
                  scope="col"
                  className="px-2 py-1 text-right font-normal text-charcoal-82"
                >
                  {m.sidePane.colOutputPrice}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  data-testid={`model-catalog-side-pane-row-${r.provider}-${r.model}`}
                  className="border-t border-border-warm"
                >
                  <td className="px-2 py-1 text-foreground">
                    {mp[r.provider] ?? r.provider}
                  </td>
                  <td className="px-2 py-1 text-foreground">{r.model}</td>
                  <td className="px-2 py-1 text-right text-charcoal-82">
                    {r.inputPriceLabel}
                  </td>
                  <td className="px-2 py-1 text-right text-charcoal-82">
                    {r.outputPriceLabel}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </aside>
  );
}
