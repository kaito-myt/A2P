/**
 * 法務ページ (プライバシーポリシー / 利用規約) の共通設定。
 * 事業者名・連絡先・サービス名はここを編集すれば両ページに反映される。
 * TikTok 等の外部 API 審査で URL 提出に使う想定の公開ページ。
 */
export const LEGAL = {
  serviceName: 'A2P（Amazon Automated Publishing Tool）',
  /** 運営者（個人）。 */
  operator: '宮田海斗',
  /** 審査者向け英語表記（ローマ字）。 */
  operatorEn: 'Kaito Miyata',
  contactEmail: 'kaito.myt@gmail.com',
  /** 最終更新日 (制定日)。改定時に更新する。 */
  updatedAt: '2026-07-23',
  /** 連携する外部サービス (プライバシーポリシーに列挙)。 */
  thirdParties: [
    { name: 'TikTok (TikTok for Developers / Content Posting API)', purpose: '運営者自身のアカウントへ動画を投稿するため' },
    { name: 'X (旧 Twitter)', purpose: '運営者自身のアカウントへ投稿するため' },
    { name: 'Instagram（Make.com 経由）', purpose: '運営者自身のアカウントへ投稿するため' },
    { name: 'OpenAI', purpose: '画像・音声・テキスト生成のため' },
    { name: 'Anthropic', purpose: 'テキスト生成のため' },
    { name: 'Amazon KDP', purpose: '電子書籍の出版・売上取得のため' },
    { name: 'Cloudflare R2', purpose: '生成物（画像・動画等）の保管のため' },
    { name: 'Railway', purpose: 'アプリケーション・データベースのホスティングのため' },
  ],
} as const;
