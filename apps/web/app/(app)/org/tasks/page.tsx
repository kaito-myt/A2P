/**
 * docs/06 — 全社ToDoボード (/org/tasks)。
 * CEO→本部長→担当者の仕事を、本部別・状態別のカンバンで管理する。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { prisma } from '@a2p/db';

import { messages } from '@/lib/messages';
import { OrgTaskBoard } from '@/components/org/org-task-board';
import { mapOrgTaskRow, type DbOrgTask } from '@/lib/org-view';

export const metadata: Metadata = {
  title: `${messages.org.board.pageTitle} | ${messages.brand.appName}`,
};

export const dynamic = 'force-dynamic';

const m = messages.org.board;

export default async function OrgTasksPage() {
  const tasksRaw = await prisma.orgTask.findMany({
    orderBy: [{ created_at: 'desc' }],
    take: 400,
    select: {
      id: true,
      division: true,
      book_id: true,
      owner_role: true,
      assignee_role: true,
      channel: true,
      account_ref: true,
      kind: true,
      title: true,
      instruction: true,
      status: true,
      priority: true,
      cost_jpy: true,
      created_at: true,
      book: { select: { title: true } },
    },
  });
  const tasks = tasksRaw.map((t) => mapOrgTaskRow(t as unknown as DbOrgTask));

  return (
    <div className="flex flex-col gap-space-loose" data-testid="org-tasks-page">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">ホーム</Link>
          <span aria-hidden="true"> &gt; </span>
          <Link href="/org" className="no-underline hover:underline">{messages.org.dashboard.pageTitle}</Link>
          <span aria-hidden="true"> &gt; </span>
          <span>{m.pageTitle}</span>
        </nav>
        <div className="flex flex-col">
          <h1 className="text-sub-heading text-foreground">{m.pageTitle}</h1>
          <p className="text-body text-muted">{m.pageSubtitle}</p>
        </div>
      </header>

      <OrgTaskBoard tasks={tasks} />
    </div>
  );
}
