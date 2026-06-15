/**
 * JobTicker placeholder (docs/04 §6.4.7).
 *
 * Phase 1 SP-01 では本値の購読が未実装のため "—" を表示する。
 * SP-04 で graphile-worker と接続後、`running` / `limit` を実値に差し替える。
 */
import { messages } from '@/lib/messages';

export function JobTicker() {
  return (
    <div className="inline-flex w-full items-center justify-between rounded-pill bg-charcoal-04 px-3 py-1.5 text-button-sm text-charcoal-82">
      <span>{messages.nav.jobTickerLabel}</span>
      <span aria-label={messages.nav.jobTickerFallback}>{messages.nav.jobTickerFallback}</span>
    </div>
  );
}
