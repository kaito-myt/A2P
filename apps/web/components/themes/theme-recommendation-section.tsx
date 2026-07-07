/**
 * S-007 Amazon 売れ筋レコメンドセクション (F-001b)。
 *
 * Marketer が Amazon Kindle 売れ筋ランキングを調べて算出した「おすすめ度」を表示する。
 *   - market_score (0-100) / demand_level / competition_level
 *   - recommendation (推薦理由)
 *   - bestseller_evidence (観測した売れ筋の類書)
 */
import { messages } from '@/lib/messages';
import type { ThemeDetailSerialized } from '@/lib/themes-view';

const m = messages.themes.detail.recommendation;

const LEVEL_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低' };
const DEMAND_STYLE: Record<string, string> = {
  high: 'border-success/30 bg-success/10 text-success',
  medium: 'border-warning/30 bg-warning/10 text-warning',
  low: 'border-border-warm bg-charcoal-04 text-charcoal-82',
};

export function ThemeRecommendationSection({ detail }: { detail: ThemeDetailSerialized }) {
  const s = detail.signals;
  const score = detail.market_score;
  const evidence = s.bestseller_evidence ?? [];

  // 何も情報が無ければ描画しない (旧データ互換)。
  if (
    score === null &&
    !s.demand_level &&
    !s.competition_level &&
    !s.recommendation &&
    evidence.length === 0
  ) {
    return null;
  }

  return (
    <section
      data-testid="theme-recommendation-section"
      className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed"
    >
      <div className="flex flex-wrap items-center gap-space-snug">
        <h2 className="text-button font-medium text-charcoal">{m.sectionTitle}</h2>
        {score !== null && (
          <span className="rounded-pill border border-accent/30 bg-accent/10 px-2.5 py-0.5 text-button-sm font-medium text-accent">
            {m.scoreLabel}: {score}
          </span>
        )}
        {s.demand_level && (
          <span
            className={`rounded-pill border px-2 py-0.5 text-caption ${
              DEMAND_STYLE[s.demand_level] ?? DEMAND_STYLE.low
            }`}
          >
            {m.demandLabel}: {LEVEL_LABEL[s.demand_level] ?? s.demand_level}
          </span>
        )}
        {s.competition_level && (
          <span className="rounded-pill border border-border-warm bg-cream px-2 py-0.5 text-caption text-charcoal-82">
            {m.competitionLabel}: {LEVEL_LABEL[s.competition_level] ?? s.competition_level}
          </span>
        )}
      </div>

      {s.recommendation && s.recommendation.trim().length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-button-sm text-charcoal-82">{m.recommendationLabel}</p>
          <p className="text-body text-charcoal whitespace-pre-wrap">{s.recommendation}</p>
        </div>
      )}

      {evidence.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-button-sm text-charcoal-82">{m.evidenceLabel}</p>
          <ul className="flex flex-col gap-1">
            {evidence.map((e, i) => (
              <li
                key={i}
                className="flex flex-wrap items-baseline gap-2 rounded-card bg-cream px-2 py-1 text-caption text-charcoal"
              >
                {typeof e.rank === 'number' && (
                  <span className="font-medium text-accent">#{e.rank}</span>
                )}
                <span className="font-medium">{e.title ?? '(タイトル不明)'}</span>
                {e.note && <span className="text-muted">— {e.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
