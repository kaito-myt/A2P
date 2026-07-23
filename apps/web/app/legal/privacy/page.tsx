/**
 * プライバシーポリシー (公開ページ)。TikTok 等の外部 API 審査で提出する URL に対応。
 * 事業者名・連絡先は ../config.ts で管理。
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { LEGAL } from '../config';

export const metadata: Metadata = {
  title: 'プライバシーポリシー',
  description: `${LEGAL.serviceName} のプライバシーポリシー`,
};

const H = ({ children }: { children: ReactNode }) => (
  <h2 className="mt-4 text-lg font-bold text-charcoal">{children}</h2>
);

export default function PrivacyPolicyPage() {
  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight text-charcoal">プライバシーポリシー</h1>
        <p className="text-caption text-muted">最終更新日: {LEGAL.updatedAt}</p>
      </header>

      <p>
        {LEGAL.operator}（以下「当方」）は、{LEGAL.serviceName}（以下「本サービス」）における利用者および
        連携する外部サービスから取得する情報の取り扱いについて、本プライバシーポリシーを定めます。本サービスは
        当方が自身の電子書籍の制作・出版・販促を自動化するために運用する個人用ツールです。
      </p>

      <H>1. 取得する情報</H>
      <ul className="ml-5 list-disc space-y-1">
        <li>アカウント情報（ログイン用のユーザー名等）。</li>
        <li>
          連携する外部プラットフォーム（TikTok・X・Instagram 等）の <strong>OAuth アクセストークン／リフレッシュトークン</strong>。
          これらは当方が運用する自身のアカウントへ投稿するためにのみ使用します。
        </li>
        <li>本サービスで生成・投稿するコンテンツ（テキスト・画像・動画）および投稿履歴。</li>
        <li>利用状況・コスト計測のための技術的ログ。</li>
      </ul>

      <H>2. TikTok から取得する情報とその利用目的</H>
      <p>
        本サービスは TikTok Content Posting API を利用し、<strong>運営者自身の TikTok アカウントに、
        本サービスで生成した宣伝用の動画を投稿する目的にのみ</strong> TikTok の認可情報（アクセストークン等）を
        使用します。当方は次を遵守します。
      </p>
      <ul className="ml-5 list-disc space-y-1">
        <li>TikTok から取得したデータを、上記の投稿目的以外に利用しません。</li>
        <li>TikTok から取得したデータを第三者に販売・提供・共有しません。</li>
        <li>取得する権限（スコープ）は投稿に必要な最小限（`video.upload` / `video.publish` 等）に限定します。</li>
        <li>利用者はいつでも本サービスの接続を解除でき、TikTok 側の設定からも連携を取り消せます。</li>
      </ul>

      <H>3. 情報の保管とセキュリティ</H>
      <p>
        アクセストークン等の認証情報は <strong>暗号化して保存</strong>（AES-256-GCM）し、平文で表示・記録しません。
        データはホスティング事業者（Railway）およびオブジェクトストレージ（Cloudflare R2）上に保管されます。
      </p>

      <H>4. 連携する外部サービス</H>
      <p>本サービスは目的達成のため以下の外部サービスを利用します。</p>
      <ul className="ml-5 list-disc space-y-1">
        {LEGAL.thirdParties.map((t) => (
          <li key={t.name}>
            <strong>{t.name}</strong> — {t.purpose}
          </li>
        ))}
      </ul>

      <H>5. データの保持と削除</H>
      <p>
        情報は本サービスの運用に必要な期間保持します。連携解除により保存済みの認証情報は削除・無効化されます。
        削除のご要望は下記連絡先までお問い合わせください。
      </p>

      <H>6. 第三者提供</H>
      <p>
        当方は、法令に基づく場合を除き、取得した情報を本人の同意なく第三者に提供しません。特に、連携プラット
        フォームから取得したデータを広告・分析等の目的で第三者に提供することはありません。
      </p>

      <H>7. 改定</H>
      <p>本ポリシーは必要に応じて改定することがあります。重要な変更がある場合は本ページで告知します。</p>

      <H>8. お問い合わせ</H>
      <p>
        本ポリシーおよび情報の取り扱いに関するお問い合わせ先:{' '}
        <a href={`mailto:${LEGAL.contactEmail}`} className="text-accent hover:underline">
          {LEGAL.contactEmail}
        </a>
      </p>

      <hr className="my-4 border-border-warm" />

      <H>English summary (for reviewers)</H>
      <p className="text-caption text-muted">
        {LEGAL.serviceName} is a personal tool operated by {LEGAL.operator} to automate the creation and promotion of
        the operator&apos;s own e-books. It uses the TikTok Content Posting API solely to publish
        operator-generated promotional videos to the operator&apos;s own TikTok account. OAuth tokens are stored
        encrypted (AES-256-GCM), used only for posting, and are never sold or shared with third parties. Requested
        scopes are limited to what is required for posting. Users can disconnect at any time in the app or revoke
        access in TikTok settings. Contact: {LEGAL.contactEmail}.
      </p>
    </>
  );
}
