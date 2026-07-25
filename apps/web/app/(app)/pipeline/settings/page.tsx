/**
 * パイプライン設定 RSC ページ (S-pipeline-settings)。
 *
 * 出版パイプラインの各工程を AI 判断で自動パスするか設定する。AppSettings(singleton) を読み、
 * 未存在なら既定値を用いる。書き込みは updatePipelineSettings SA (クライアントフォーム経由)。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import { serializePipelineSettings, type PipelineSettingsView } from '@/lib/pipeline-settings-core';
import { PipelineSettingsForm } from '@/components/pipeline/pipeline-settings-form';

export const metadata: Metadata = { title: `${messages.pipelineSettings.pageTitle} | ${messages.brand.appName}` };
export const dynamic = 'force-dynamic';

const m = messages.pipelineSettings;

const DEFAULTS: PipelineSettingsView = {
  autopass_theme_enabled: false,
  pipeline_themes_per_day: 3,
  pipeline_theme_direction: '',
  autopass_outline_enabled: false,
  autopass_content_enabled: false,
  autopass_cover_enabled: false,
  autopass_kdp_enabled: false,
};

export default async function PipelineSettingsPage() {
  const row = await prisma.appSettings.findUnique({
    where: { id: 'singleton' },
    select: {
      autopass_theme_enabled: true,
      pipeline_themes_per_day: true,
      pipeline_theme_direction: true,
      autopass_outline_enabled: true,
      autopass_content_enabled: true,
      autopass_cover_enabled: true,
      autopass_kdp_enabled: true,
    },
  });
  const initial = row ? serializePipelineSettings(row) : DEFAULTS;

  return (
    <div className="flex flex-col gap-space-loose" data-testid="pipeline-settings-page">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            {m.breadcrumbHome}
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.breadcrumbPipeline}</span>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.pageTitle}</span>
        </nav>
        <div>
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
      </header>

      <PipelineSettingsForm initial={initial} />
    </div>
  );
}
