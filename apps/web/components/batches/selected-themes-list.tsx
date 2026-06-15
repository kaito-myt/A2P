/**
 * S-008 採用済みテーマリスト (T-03-09, RSC).
 *
 * `/batches/new?theme_ids=...` の query から復元した ThemeCandidate を表示する。
 * 行追加/削除は SP-04 で実装するため、本タスクでは「読み取り表示 + 状態警告」
 * までを担う (status='accepted' でない行は赤バッジで強調)。
 */
import { messages } from '@/lib/messages';

const m = messages.batches.selected;

export interface SelectedThemeRow {
  id: string;
  title: string;
  genre: string;
  account_id: string;
  account_pen_name: string | null;
  target_reader: string | null;
  status: string;
}

interface SelectedThemesListProps {
  rows: readonly SelectedThemeRow[];
}

function genreLabel(genre: string): string {
  if (genre === 'practical' || genre === 'business' || genre === 'self_help') {
    return m.genres[genre];
  }
  return m.genreUnknown;
}

export function SelectedThemesList({ rows }: SelectedThemesListProps) {
  if (rows.length === 0) {
    return (
      <section
        data-testid="selected-themes-list"
        className="rounded-card border border-border-warm bg-cream-light p-space-loose"
      >
        <h2 className="text-card-title text-foreground">{m.sectionTitle}</h2>
        <div className="mt-space-snug text-center">
          <p className="text-body font-medium text-charcoal">{m.empty}</p>
          <p className="mt-1 text-body text-muted">{m.emptyHint}</p>
        </div>
      </section>
    );
  }

  return (
    <section
      data-testid="selected-themes-list"
      className="rounded-card border border-border-warm bg-cream"
    >
      <div className="flex items-center justify-between px-space-loose pt-space-loose">
        <h2 className="text-card-title text-foreground">
          {m.sectionTitle}
          <span className="ml-2 text-button-sm text-muted">
            {m.sectionCount(rows.length)}
          </span>
        </h2>
      </div>
      <div className="overflow-x-auto px-space-loose pb-space-loose pt-space-snug">
        <table className="w-full border-collapse text-button-sm">
          <thead>
            <tr className="border-b border-border-warm text-left text-muted">
              <th className="py-2 pr-3 font-medium">{m.colTitle}</th>
              <th className="py-2 pr-3 font-medium">{m.colGenre}</th>
              <th className="py-2 pr-3 font-medium">{m.colAccount}</th>
              <th className="py-2 pr-3 font-medium">{m.colTargetReader}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                data-testid={`selected-theme-row-${r.id}`}
                className="border-b border-border-warm/60 last:border-b-0"
              >
                <td className="py-2 pr-3 text-foreground">{r.title}</td>
                <td className="py-2 pr-3 text-charcoal-82">{genreLabel(r.genre)}</td>
                <td className="py-2 pr-3 text-charcoal-82">
                  {r.account_pen_name ?? r.account_id}
                </td>
                <td className="py-2 pr-3 text-charcoal-82">
                  {r.target_reader ?? m.targetReaderEmpty}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
