'use client';

/**
 * ProposalDetail — S-023 提案詳細右カラム (T-11-07).
 *
 * - 改訂意図 / 期待効果カード
 * - DiffViewer (unified diff)
 * - サンプル出力比較
 * - ActionBar
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { messages } from '@/lib/messages';
import type { ProposalDetail as ProposalDetailType } from '@/lib/prompt-proposals-view';
import { DiffViewer } from './diff-viewer';
import { ActionBar } from './action-bar';

const m = messages.promptProposals.detail;

interface ProposalDetailProps {
  proposal: ProposalDetailType;
}

function formatExpectedEffect(json: unknown): string {
  if (!json || typeof json !== 'object') return String(json ?? '—');
  const obj = json as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof obj.score_delta === 'number') {
    parts.push(`Quality ${obj.score_delta > 0 ? '+' : ''}${obj.score_delta}`);
  }
  if (typeof obj.sales_delta_pct === 'number') {
    parts.push(`売上 ${obj.sales_delta_pct > 0 ? '+' : ''}${obj.sales_delta_pct}%`);
  }
  return parts.length > 0 ? parts.join(' / ') : JSON.stringify(obj);
}

export function ProposalDetail({ proposal }: ProposalDetailProps) {
  const proposedVersion = proposal.source_version + 1;
  const genreLabel = proposal.genre ?? messages.promptProposals.table.genreDefault;
  const title = m.sectionTitle(proposal.role, genreLabel, proposal.source_version, proposedVersion);

  return (
    <div data-testid="proposal-detail" className="flex flex-col gap-space-snug">
      {/* ヘッダー */}
      <h2 className="text-sub-heading text-foreground">{title}</h2>

      {/* 改訂意図 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">{m.rationaleLabel}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-body text-charcoal-82">{proposal.rationale}</p>
        </CardContent>
      </Card>

      {/* 期待効果 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-card-title">{m.expectedEffectLabel}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-body text-charcoal">{formatExpectedEffect(proposal.expected_effect_json)}</p>
        </CardContent>
      </Card>

      {/* Diff */}
      <DiffViewer
        diff={proposal.diff}
        sourceVersion={proposal.source_version}
        proposedVersion={proposedVersion}
      />

      {/* サンプル出力比較 */}
      {proposal.sample_output ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-card-title">{m.sampleOutputTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-space-snug md:grid-cols-2">
              <div>
                <p className="mb-1 text-button-sm font-medium text-muted">
                  {m.diffOldLabel(proposal.source_version)}
                </p>
                <pre className="overflow-x-auto rounded-default border border-border-warm bg-cream-light p-3 text-caption leading-relaxed text-charcoal-82 whitespace-pre-wrap">
                  {proposal.source_prompt_body.slice(0, 500)}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-button-sm font-medium text-muted">
                  {m.diffNewLabel(proposedVersion)}
                </p>
                <pre className="overflow-x-auto rounded-default border border-border-warm bg-cream-light p-3 text-caption leading-relaxed text-charcoal-82 whitespace-pre-wrap">
                  {proposal.sample_output.slice(0, 500)}
                </pre>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-card-title">{m.sampleOutputTitle}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-body text-muted">{m.sampleOutputEmpty}</p>
          </CardContent>
        </Card>
      )}

      {/* アクションバー */}
      <ActionBar proposal={proposal} />
    </div>
  );
}
