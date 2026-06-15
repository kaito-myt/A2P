/**
 * AccountsTable (S-003)。
 *
 * RSC で Prisma 直接呼び出し → 8 列のテーブルを描画。
 * 累計出版数 / 売上 / 平均 Quality / 最終出版日 は Phase 1 で集計テーブルが
 * まだ無いため 0 / — 固定。本実装は SP-06 (book pipeline) / SP-07 (sales) で。
 */
import Link from 'next/link';
import type { Account } from '@a2p/db';
import { Button } from '@/components/ui/button';
import { messages } from '@/lib/messages';
import { ArchiveButton } from './archive-button';

interface AccountsTableProps {
  accounts: Account[];
}

export function AccountsTable({ accounts }: AccountsTableProps) {
  const m = messages.accounts.table;

  return (
    <div className="overflow-x-auto rounded-card border border-border-warm">
      <table className="w-full border-collapse text-body">
        <thead className="bg-charcoal-04">
          <tr>
            <Th>{m.penName}</Th>
            <Th>{m.genrePolicy}</Th>
            <Th align="right">{m.publishedCount}</Th>
            <Th align="right">{m.totalSales}</Th>
            <Th align="right">{m.avgQuality}</Th>
            <Th>{m.lastPublishedAt}</Th>
            <Th align="right">{m.actions}</Th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id} className="border-t border-border-warm">
              <Td>
                <Link
                  href={`/accounts/${a.id}`}
                  className="text-charcoal no-underline hover:underline"
                >
                  {a.pen_name}
                </Link>
              </Td>
              <Td>
                <GenrePolicyMini policyJson={a.genre_policy_json} />
              </Td>
              <Td align="right">
                0 {m.countSuffix}
              </Td>
              <Td align="right">¥0</Td>
              <Td align="right">{m.none}</Td>
              <Td>{m.noPublished}</Td>
              <Td align="right">
                <div className="flex items-center justify-end gap-2">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/accounts/${a.id}`}>{m.edit}</Link>
                  </Button>
                  <ArchiveButton accountId={a.id} penName={a.pen_name} />
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-border-warm bg-charcoal-03 px-space-relaxed py-2 text-button-sm text-muted">
        {m.pagination(accounts.length, accounts.length)}
      </div>
    </div>
  );
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

interface GenrePolicy {
  primary_genre?: string;
  ratio?: Record<string, number>;
}

function GenrePolicyMini({ policyJson }: { policyJson: unknown }) {
  const m = messages.accounts.table;
  const policy = (policyJson ?? {}) as GenrePolicy;
  const ratio = policy.ratio ?? {};
  const genres = ['practical', 'business', 'self_help'] as const;
  return (
    <div className="flex items-center gap-1">
      {genres.map((g) => {
        const v = Math.round((ratio[g] ?? 0) * 100);
        return (
          <span
            key={g}
            className="rounded-micro border border-border-warm bg-cream-light px-1.5 py-0.5 text-button-sm text-charcoal-82"
            title={m.genres[g]}
          >
            <span className="text-muted">{m.genres[g].slice(0, 1)}</span> {v}%
          </span>
        );
      })}
    </div>
  );
}
