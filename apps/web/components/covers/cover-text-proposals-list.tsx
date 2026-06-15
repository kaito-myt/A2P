'use client';

/**
 * S-012 CoverTextProposalsList (T-05-10, F-006).
 *
 * Displays 3-5 cover text proposals (title / subtitle / band_copy)
 * for the current book in single-detail mode.
 *
 * data-testid:
 *  - cover-text-proposals
 *  - cover-text-proposal-{id}
 */
import { messages } from '@/lib/messages';
import type { CoverTextProposalSerialized } from '@/lib/covers-view';

const m = messages.covers.coverText;

interface CoverTextProposalsListProps {
  proposals: readonly CoverTextProposalSerialized[];
}

export function CoverTextProposalsList({
  proposals,
}: CoverTextProposalsListProps) {
  return (
    <section
      data-testid="cover-text-proposals"
      className="flex flex-col gap-space-snug"
    >
      <h3 className="text-card-title font-medium text-charcoal">
        {m.sectionTitle} {m.sectionCount(proposals.length)}
      </h3>

      {proposals.length === 0 ? (
        <p className="text-button-sm text-muted">--</p>
      ) : (
        <div className="grid grid-cols-1 gap-space-snug sm:grid-cols-2 lg:grid-cols-3">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
        </div>
      )}
    </section>
  );
}

interface ProposalCardProps {
  proposal: CoverTextProposalSerialized;
}

function ProposalCard({ proposal }: ProposalCardProps) {
  const statusLabel =
    proposal.status === 'adopted'
      ? m.adopted
      : proposal.status === 'rejected'
        ? m.rejected
        : m.proposed;

  return (
    <div
      data-testid={`cover-text-proposal-${proposal.id}`}
      className={`flex flex-col gap-2 rounded-card border p-space-snug ${
        proposal.status === 'adopted'
          ? 'border-charcoal bg-cream'
          : 'border-border-warm bg-cream-light'
      }`}
    >
      <div className="flex items-center justify-between">
        <span
          className={`text-button-sm ${
            proposal.status === 'adopted'
              ? 'font-medium text-charcoal'
              : 'text-muted'
          }`}
        >
          {statusLabel}
        </span>
      </div>

      <dl className="flex flex-col gap-1 text-body">
        <div>
          <dt className="text-button-sm font-medium text-charcoal-82">
            {m.mainTitle}
          </dt>
          <dd className="text-charcoal">{proposal.title}</dd>
        </div>
        {proposal.subtitle && (
          <div>
            <dt className="text-button-sm font-medium text-charcoal-82">
              {m.subtitle}
            </dt>
            <dd className="text-charcoal">{proposal.subtitle}</dd>
          </div>
        )}
        {proposal.band_copy && (
          <div>
            <dt className="text-button-sm font-medium text-charcoal-82">
              {m.bandCopy}
            </dt>
            <dd className="text-charcoal">{proposal.band_copy}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
