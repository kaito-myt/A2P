/**
 * S-007 競合本テーブル (T-03-08).
 *
 * RSC で OK。表示列: # / タイトル / 著者 / ASIN / 順位 / レビュー要約 / URL。
 * 空欄セルは "—"、competitors=0 件時は empty state。
 *
 * data-testid: competitors-table / competitor-row-{index} / competitor-title /
 *              competitor-link
 */
import { messages } from '@/lib/messages';
import type { Competitor } from '@/lib/themes-view';

const mc = messages.themes.detail.competitors;

interface CompetitorsTableProps {
  competitors: readonly Competitor[];
}

export function CompetitorsTable({ competitors }: CompetitorsTableProps) {
  return (
    <section
      data-testid="competitors-table"
      className="flex flex-col gap-space-snug"
    >
      <h2 className="text-button font-medium text-charcoal">
        {mc.sectionTitle}
        <span className="text-button-sm text-charcoal-82">
          {mc.sectionCount(competitors.length)}
        </span>
      </h2>

      {competitors.length === 0 ? (
        <p
          data-testid="competitors-empty"
          className="rounded-card border border-border-warm bg-cream-light p-space-relaxed text-body text-muted"
        >
          {mc.empty}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-border-warm">
          <table className="w-full border-collapse text-body">
            <thead className="bg-charcoal-04">
              <tr>
                <Th align="right" className="w-10">
                  {mc.colIndex}
                </Th>
                <Th>{mc.colTitle}</Th>
                <Th>{mc.colAuthor}</Th>
                <Th>{mc.colAsin}</Th>
                <Th align="right">{mc.colRank}</Th>
                <Th>{mc.colReviewSummary}</Th>
                <Th>{mc.colUrl}</Th>
              </tr>
            </thead>
            <tbody>
              {competitors.map((c, idx) => (
                <tr
                  key={`${c.asin ?? c.title ?? 'row'}-${idx}`}
                  data-testid={`competitor-row-${idx}`}
                  className="border-t border-border-warm"
                >
                  <Td align="right">{idx + 1}</Td>
                  <Td>
                    <span
                      data-testid="competitor-title"
                      className="text-charcoal"
                    >
                      {c.title ?? mc.emptyCell}
                    </span>
                  </Td>
                  <Td>{c.author ?? mc.emptyCell}</Td>
                  <Td>{c.asin ?? mc.emptyCell}</Td>
                  <Td align="right">{c.rank ?? mc.emptyCell}</Td>
                  <Td>{c.review_summary ?? mc.emptyCell}</Td>
                  <Td>
                    {c.url ? (
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        data-testid="competitor-link"
                        className="text-charcoal underline-offset-4 hover:underline"
                      >
                        {mc.linkText}
                      </a>
                    ) : (
                      mc.emptyCell
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Th({
  children,
  align = 'left',
  className,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-space-relaxed py-2 text-button-sm font-normal text-charcoal-82 ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${className ?? ''}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = 'left',
  className,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  return (
    <td
      className={`px-space-relaxed py-3 text-body align-middle ${
        align === 'right' ? 'text-right' : 'text-left'
      } ${className ?? ''}`}
    >
      {children}
    </td>
  );
}
