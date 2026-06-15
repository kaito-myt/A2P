/**
 * S-022 プロンプト管理画面 (T-11-08).
 *
 * RSC page:
 *  - listActivePrompts でプロンプト一覧取得
 *  - ?role= ?genre= searchParams で選択中プロンプトの詳細取得
 *  - 左カラム: プロンプト一覧テーブル
 *  - 右カラム: タブ(現行本文 / 過去バージョン / A/B 配信設定)
 *
 * 仕様根拠: docs/04 S-022 / docs/05 §4.3.11 / SP-11 T-11-08
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import {
  listActivePrompts,
  getPromptVersionHistory,
  getAbDistributionViewData,
  type PromptListItem,
} from '@/lib/prompts-view';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs';
import { AbDistributionForm } from '@/components/prompts/ab-distribution-form';

export const metadata: Metadata = {
  title: `${messages.prompts.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.prompts;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function sp(
  params: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const v = params[key];
  return Array.isArray(v) ? v[0] : v;
}

function buildUrl(base: string, role: string, genre: string | null): string {
  const params = new URLSearchParams({ role });
  if (genre) params.set('genre', genre);
  return `${base}?${params.toString()}`;
}

export default async function PromptsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const selectedRole = sp(params, 'role');
  const selectedGenre = sp(params, 'genre') ?? null;

  const prompts = await listActivePrompts(prisma);

  const selected: PromptListItem | null =
    selectedRole
      ? (prompts.find((p) => p.role === selectedRole && p.genre === (selectedGenre ?? null)) ?? null)
      : null;

  const [versionHistory, abViewData] = selected
    ? await Promise.all([
        getPromptVersionHistory(selected.role, selected.genre, prisma),
        getAbDistributionViewData(selected.role, selected.genre, prisma),
      ])
    : [[], { current: null, candidates: [] }];

  return (
    <div className="flex flex-col gap-space-loose" data-testid="prompts-page">
      {/* ページヘッダー */}
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbModels}</span>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbPrompts}</span>
        </nav>
        <div>
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
      </header>

      {/* 2 カラムレイアウト */}
      <div className="grid grid-cols-1 gap-space-loose lg:grid-cols-5">
        {/* 左カラム: プロンプト一覧 */}
        <div className="flex flex-col gap-space-snug lg:col-span-2" data-testid="prompts-list-col">
          <h2 className="text-card-title font-medium text-foreground">
            {m.table.sectionTitle}
          </h2>

          {prompts.length === 0 ? (
            <p className="text-body text-muted" data-testid="prompts-empty">
              {m.table.empty}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-card border border-border-warm">
              <table className="w-full text-body" data-testid="prompts-table">
                <thead>
                  <tr className="border-b border-border-warm bg-cream-light text-left">
                    <th className="px-3 py-2 text-button-sm font-medium text-foreground">
                      {m.table.colRole}
                    </th>
                    <th className="px-3 py-2 text-button-sm font-medium text-foreground">
                      {m.table.colGenre}
                    </th>
                    <th className="px-3 py-2 text-button-sm font-medium text-foreground">
                      {m.table.colVersion}
                    </th>
                    <th className="px-3 py-2 text-button-sm font-medium text-foreground">
                      {m.table.colAb}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {prompts.map((prompt) => {
                    const isSelected =
                      selected?.role === prompt.role && selected?.genre === prompt.genre;
                    return (
                      <tr
                        key={prompt.id}
                        data-testid={`prompts-row-${prompt.id}`}
                        className={`cursor-pointer border-b border-border-warm transition-colors last:border-0 hover:bg-cream-light ${
                          isSelected ? 'bg-cream-light font-medium' : ''
                        }`}
                      >
                        <td className="px-3 py-2">
                          <Link
                            href={buildUrl('/prompts', prompt.role, prompt.genre)}
                            className="block no-underline text-foreground hover:underline"
                          >
                            {prompt.role}
                          </Link>
                        </td>
                        <td className="px-3 py-2 text-foreground">
                          {prompt.genre ?? m.table.genreDefault}
                        </td>
                        <td className="px-3 py-2 text-foreground">
                          v{prompt.version}
                        </td>
                        <td className="px-3 py-2">
                          {m.table.noAb}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 右カラム: プロンプト詳細 */}
        <div className="lg:col-span-3" data-testid="prompts-detail-col">
          {!selected ? (
            <div
              data-testid="prompts-detail-empty"
              className="flex h-full min-h-48 items-center justify-center rounded-card border border-border-warm bg-cream-light p-space-loose text-center"
            >
              <p className="text-body text-muted">{m.selectHint}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-space-snug">
              <p className="text-sub-heading font-medium text-foreground">
                {selected.role} × {selected.genre ?? m.table.genreDefault} — active: v{selected.version}
              </p>

              <Tabs defaultValue="body">
                <TabsList>
                  <TabsTrigger value="body">{m.tabs.body}</TabsTrigger>
                  <TabsTrigger value="history">{m.tabs.history}</TabsTrigger>
                  <TabsTrigger value="ab" data-testid="tab-trigger-ab">
                    {m.tabs.ab}
                  </TabsTrigger>
                </TabsList>

                {/* タブ 1: 現行本文 */}
                <TabsContent value="body" data-testid="tab-content-body">
                  <div className="flex flex-col gap-space-snug">
                    {versionHistory.length > 0 ? (
                      <>
                        <h3 className="text-card-title font-medium text-foreground">
                          {m.body.sectionTitle}
                        </h3>
                        <pre
                          className="overflow-auto rounded-card border border-border-warm bg-cream-light p-space-snug font-mono text-body text-foreground"
                          data-testid="prompt-body-content"
                        >
                          {versionHistory[0]?.body ?? ''}
                        </pre>
                        <p className="text-button-sm text-muted italic">
                          {m.body.editPlaceholder}
                        </p>
                      </>
                    ) : (
                      <p className="text-body text-muted">{m.body.noBody}</p>
                    )}
                  </div>
                </TabsContent>

                {/* タブ 2: 過去バージョン */}
                <TabsContent value="history" data-testid="tab-content-history">
                  <div className="flex flex-col gap-space-snug">
                    <h3 className="text-card-title font-medium text-foreground">
                      {m.history.sectionTitle}
                    </h3>
                    {versionHistory.length === 0 ? (
                      <p className="text-body text-muted">{m.history.empty}</p>
                    ) : (
                      <div className="overflow-x-auto rounded-card border border-border-warm">
                        <table className="w-full text-body" data-testid="version-history-table">
                          <thead>
                            <tr className="border-b border-border-warm bg-cream-light text-left">
                              <th className="px-3 py-2 text-button-sm font-medium text-foreground">
                                {m.history.colVersion}
                              </th>
                              <th className="px-3 py-2 text-button-sm font-medium text-foreground">
                                {m.history.colStatus}
                              </th>
                              <th className="px-3 py-2 text-button-sm font-medium text-foreground">
                                {m.history.colCreatedBy}
                              </th>
                              <th className="px-3 py-2 text-button-sm font-medium text-foreground">
                                {m.history.colActivatedAt}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {versionHistory.map((v) => (
                              <tr
                                key={v.id}
                                data-testid={`version-row-${v.id}`}
                                className="border-b border-border-warm last:border-0"
                              >
                                <td className="px-3 py-2 text-foreground">v{v.version}</td>
                                <td className="px-3 py-2 text-foreground">
                                  <span
                                    className={`inline-flex rounded px-1.5 py-0.5 text-button-sm ${
                                      v.status === 'active'
                                        ? 'bg-accent/20 text-accent'
                                        : 'bg-charcoal-04 text-muted'
                                    }`}
                                  >
                                    {v.status === 'active'
                                      ? m.history.statusActive
                                      : m.history.statusArchived}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-muted">{v.created_by}</td>
                                <td className="px-3 py-2 text-muted">
                                  {v.activated_at
                                    ? new Date(v.activated_at).toLocaleDateString('ja-JP')
                                    : m.history.noDate}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* タブ 3: A/B 配信設定 */}
                <TabsContent value="ab" data-testid="tab-content-ab">
                  <AbDistributionForm
                    role={selected.role}
                    genre={selected.genre}
                    current={abViewData.current}
                    candidates={abViewData.candidates}
                  />
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
