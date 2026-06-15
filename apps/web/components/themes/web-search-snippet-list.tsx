/**
 * S-007 Web 検索シグナル一覧 (T-03-08).
 *
 * RSC で OK。Marketer (`packages/contracts/agents/marketer`) の `ThemeSignals`
 * から:
 *   - reasoning (選定理由)
 *   - search_keywords (検索キーワード一覧)
 *   - sources (参照 URL リスト)
 *   - search_volume / rank_estimate / predicted_chapters (数値メタ)
 * を表示する。各要素が空でも UI が成立するよう defensive。
 *
 * data-testid: web-search-snippet-list / search-keyword-{index} /
 *              search-source-{index}
 */
import { messages } from '@/lib/messages';
import type { Signals } from '@/lib/themes-view';

const mw = messages.themes.detail.signals;

interface WebSearchSnippetListProps {
  signals: Signals;
}

export function WebSearchSnippetList({ signals }: WebSearchSnippetListProps) {
  const keywords = signals.search_keywords ?? [];
  const sources = signals.sources ?? [];
  const hasReasoning = typeof signals.reasoning === 'string' && signals.reasoning.length > 0;
  const hasNumericMeta =
    typeof signals.search_volume === 'number' ||
    typeof signals.rank_estimate === 'number' ||
    typeof signals.predicted_chapters === 'number';

  const isEmpty =
    !hasReasoning && keywords.length === 0 && sources.length === 0 && !hasNumericMeta;

  return (
    <section
      data-testid="web-search-snippet-list"
      className="flex flex-col gap-space-snug rounded-card border border-border-warm bg-cream-light p-space-relaxed"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-button font-medium text-charcoal">{mw.sectionTitle}</h2>
        <p className="text-button-sm text-muted">{mw.sectionHint}</p>
      </div>

      {isEmpty ? (
        <p data-testid="web-search-snippet-empty" className="text-body text-muted">
          {mw.empty}
        </p>
      ) : (
        <>
          {hasReasoning && (
            <div className="flex flex-col gap-1">
              <p className="text-button-sm text-charcoal-82">{mw.reasoningLabel}</p>
              <p
                data-testid="theme-signals-reasoning"
                className="text-body text-charcoal whitespace-pre-wrap"
              >
                {signals.reasoning}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <p className="text-button-sm text-charcoal-82">{mw.searchKeywordsLabel}</p>
            {keywords.length === 0 ? (
              <p className="text-body text-muted">{mw.searchKeywordsEmpty}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {keywords.map((kw, idx) => (
                  <li
                    key={`${kw}-${idx}`}
                    data-testid={`search-keyword-${idx}`}
                    className="rounded-pill bg-charcoal-04 px-3 py-1 text-button-sm text-charcoal"
                  >
                    {kw}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <p className="text-button-sm text-charcoal-82">{mw.sourcesLabel}</p>
            {sources.length === 0 ? (
              <p className="text-body text-muted">{mw.sourcesEmpty}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {sources.map((src, idx) => (
                  <li
                    key={`${src}-${idx}`}
                    data-testid={`search-source-${idx}`}
                    className="text-body"
                  >
                    <a
                      href={src}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-charcoal underline-offset-4 hover:underline break-all"
                    >
                      {src}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {hasNumericMeta && (
            <dl className="flex flex-wrap gap-x-space-relaxed gap-y-1 text-button-sm text-charcoal-82">
              {typeof signals.search_volume === 'number' && (
                <div className="flex items-center gap-1">
                  <dt>{mw.searchVolumeLabel}:</dt>
                  <dd data-testid="theme-signals-search-volume">
                    {signals.search_volume}
                  </dd>
                </div>
              )}
              {typeof signals.rank_estimate === 'number' && (
                <div className="flex items-center gap-1">
                  <dt>{mw.rankEstimateLabel}:</dt>
                  <dd data-testid="theme-signals-rank-estimate">
                    {signals.rank_estimate}
                  </dd>
                </div>
              )}
              {typeof signals.predicted_chapters === 'number' && (
                <div className="flex items-center gap-1">
                  <dt>{mw.predictedChaptersLabel}:</dt>
                  <dd data-testid="theme-signals-predicted-chapters">
                    {signals.predicted_chapters}
                  </dd>
                </div>
              )}
            </dl>
          )}
        </>
      )}
    </section>
  );
}
