/**
 * 利用規約 (公開ページ)。TikTok 等の外部 API 審査で提出する URL に対応。
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { LEGAL } from '../config';

export const metadata: Metadata = {
  title: '利用規約',
  description: `${LEGAL.serviceName} の利用規約`,
};

const H = ({ children }: { children: ReactNode }) => (
  <h2 className="mt-4 text-lg font-bold text-charcoal">{children}</h2>
);

export default function TermsOfServicePage() {
  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-charcoal">利用規約</h1>
        <p className="text-caption text-muted">最終更新日: {LEGAL.updatedAt}</p>
      </header>

      <p>
        本利用規約（以下「本規約」）は、{LEGAL.operator}（以下「当方」）が提供する {LEGAL.serviceName}
        （以下「本サービス」）の利用条件を定めるものです。本サービスは当方が自身の電子書籍の制作・出版・
        販促を自動化するために運用する個人用ツールです。
      </p>

      <H>1. 適用</H>
      <p>本規約は、本サービスの利用に関わる一切の関係に適用されます。</p>

      <H>2. アカウントと認証情報</H>
      <p>
        利用者は、本サービスに連携する外部プラットフォーム（TikTok・X・Instagram 等）のアカウントについて、
        各プラットフォームの規約を遵守する責任を負います。本サービスは、連携されたアカウントに対して、
        利用者の設定・操作に基づく投稿等の処理を行います。
      </p>

      <H>3. 禁止事項</H>
      <ul className="ml-5 list-disc space-y-1">
        <li>法令または各連携プラットフォームの規約・ガイドラインに違反する行為。</li>
        <li>権利者の許諾なく第三者の著作物・商標等を投稿する行為。</li>
        <li>スパム・虚偽情報の拡散その他、各プラットフォームが禁止する行為。</li>
        <li>本サービスまたは連携先の運営を妨害する行為。</li>
      </ul>

      <H>4. コンテンツの責任</H>
      <p>
        本サービスを通じて生成・投稿されるコンテンツの内容および各プラットフォームの規約遵守について、
        利用者が責任を負うものとします。当方は、投稿内容に起因する紛争について責任を負いません。
      </p>

      <H>5. 免責事項</H>
      <p>
        当方は、本サービスの提供の中断・停止、外部プラットフォームの仕様変更や審査状況による機能制限、
        その他本サービスの利用により生じた損害について、当方の故意または重大な過失による場合を除き、
        責任を負いません。
      </p>

      <H>6. サービスの変更・終了</H>
      <p>当方は、利用者への事前告知の有無にかかわらず、本サービスの内容を変更または提供を終了できます。</p>

      <H>7. 規約の改定</H>
      <p>当方は、必要に応じて本規約を改定できます。改定後の規約は本ページに掲示した時点で効力を生じます。</p>

      <H>8. お問い合わせ</H>
      <p>
        本規約に関するお問い合わせ先:{' '}
        <a href={`mailto:${LEGAL.contactEmail}`} className="text-accent hover:underline">
          {LEGAL.contactEmail}
        </a>
      </p>
    </>
  );
}
