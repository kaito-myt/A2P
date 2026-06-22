/**
 * /help — 使い方ガイド (運営者向け操作マニュアル)。
 *
 * このツールの全体像・基本フロー・各画面の使い方・人が判断するポイントを
 * 1 ページにまとめた静的ガイド。仕様変更時はこのページを更新する。
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { messages } from '@/lib/messages';

export const metadata: Metadata = {
  title: `使い方ガイド | ${messages.brand.appName}`,
};

// ---------------------------------------------------------------------------
// 小コンポーネント
// ---------------------------------------------------------------------------

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-24 flex-col gap-space-snug">
      <h2 className="text-card-title font-medium text-foreground">{title}</h2>
      <div className="flex flex-col gap-space-snug text-body text-charcoal-82">
        {children}
      </div>
    </section>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-card border border-border-warm bg-cream-light p-space-relaxed">
      {children}
    </div>
  );
}

function Step({
  n,
  title,
  href,
  children,
}: {
  n: number;
  title: string;
  href?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-space-snug">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border-warm bg-cream text-button-sm font-medium text-charcoal">
        {n}
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-body font-medium text-foreground">
          {href ? (
            <Link href={href} className="underline underline-offset-4 hover:no-underline">
              {title}
            </Link>
          ) : (
            title
          )}
        </p>
        <div className="text-body text-charcoal-82">{children}</div>
      </div>
    </div>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="mx-0.5 inline-flex items-center rounded-pill border border-border-warm bg-cream px-2 py-0.5 text-caption text-charcoal">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ページ
// ---------------------------------------------------------------------------

export default function HelpPage() {
  return (
    <div className="flex flex-col gap-space-loose">
      <header className="flex flex-col gap-space-snug">
        <nav aria-label="breadcrumb" className="text-button-sm text-muted">
          <Link href="/dashboard" className="no-underline hover:underline">
            ホーム
          </Link>
          <span aria-hidden="true"> &gt; </span>
          <span>使い方ガイド</span>
        </nav>
        <h1 className="text-sub-heading text-foreground">使い方ガイド</h1>
        <p className="text-body text-muted">
          A2P は Amazon KDP 向けの実用書・ビジネス書・自己啓発本を、AI
          エージェントのチームで企画から入稿用データまで自動生成するツールです。
          このページで全体の流れと各画面の使い方を確認できます。
        </p>
      </header>

      {/* 目次 */}
      <Card>
        <p className="mb-2 text-button-sm font-medium text-charcoal">目次</p>
        <ol className="grid list-decimal gap-1 pl-5 text-body text-charcoal-82 sm:grid-cols-2">
          <li><a href="#overview" className="underline underline-offset-4 hover:no-underline">全体像 — 1 冊ができるまで</a></li>
          <li><a href="#quickstart" className="underline underline-offset-4 hover:no-underline">クイックスタート (最短手順)</a></li>
          <li><a href="#gates" className="underline underline-offset-4 hover:no-underline">人が判断する 2 つの関門</a></li>
          <li><a href="#screens" className="underline underline-offset-4 hover:no-underline">画面ごとの使い方</a></li>
          <li><a href="#comments" className="underline underline-offset-4 hover:no-underline">修正コメントと一括反映</a></li>
          <li><a href="#kdp" className="underline underline-offset-4 hover:no-underline">KDP への入稿手順</a></li>
          <li><a href="#cost" className="underline underline-offset-4 hover:no-underline">コスト・品質・トラブル時</a></li>
        </ol>
      </Card>

      {/* 1. 全体像 */}
      <Section id="overview" title="1. 全体像 — 1 冊ができるまで">
        <p>
          本は次の AI エージェントがバトンを渡しながら作ります。各工程はバックグラウンドの
          ジョブとして非同期に動くため、画面を閉じても進行します。
        </p>
        <Card>
          <p className="text-body leading-relaxed">
            <Tag>マーケター</Tag> テーマ候補を Web 検索付きで提案 →
            <Tag>ライター</Tag> 章立て(アウトライン)と本文を執筆 →
            <Tag>編集者</Tag> 校閲(2 段: 章ごと校閲 + 章をまたいだ整合チェック) →
            <Tag>サムネ designer</Tag> 表紙テキスト案 + 表紙画像を生成 →
            <Tag>品質ジャッジ</Tag> 100 点満点で採点 →
            <Tag>出力</Tag> Word / PDF / 表紙 PNG を生成
          </p>
        </Card>
        <p>
          完成すると <Tag>KDP 入稿</Tag> 画面に並び、メタデータ(紹介文・カテゴリ・キーワード・価格)を
          コピーしながら Amazon KDP に手で登録します。
        </p>
      </Section>

      {/* 2. クイックスタート */}
      <Section id="quickstart" title="2. クイックスタート (最短手順)">
        <div className="flex flex-col gap-space-relaxed">
          <Step n={1} title="アカウントを用意する" href="/accounts">
            まず出版に使う KDP アカウント(ペンネーム)を 1 つ登録します。すでにあれば飛ばして OK。
          </Step>
          <Step n={2} title="テーマを生成する" href="/themes">
            右上の「新規テーマ生成」を押し、キーワードや企画概要(例:「新潟競馬場の必勝法」)と
            ジャンル・生成数を入力して実行。マーケターが Web
            検索しながら候補を出すため、完了まで 1〜2 分かかります。生成中は「生成中…」表示が出て、
            完了すると自動で候補一覧に切り替わります。
          </Step>
          <Step n={3} title="テーマを採用してバッチに乗せる" href="/themes">
            良い候補にチェックを入れて「採用」。次に
            <Link href="/batches" className="mx-1 underline underline-offset-4 hover:no-underline">新規プロジェクト / バッチ計画</Link>
            から執筆バッチを作成・実行すると、ライター以降の工程が走り出します。
          </Step>
          <Step n={4} title="アウトラインを承認する" href="/outlines">
            ライターが章立てを作ると「承認待ち」になります。内容を確認して承認すると、本文執筆に進みます
            (ここが 1 つ目の関門)。
          </Step>
          <Step n={5} title="表紙を選ぶ" href="/covers">
            本文・校閲が終わると表紙候補(3 枚)が生成されます。サムネ承認画面で画像を見て 1 枚採用します。
          </Step>
          <Step n={6} title="入稿データを受け取る" href="/kdp/checklist">
            ジャッジ採点と出力が終わると KDP 入稿画面に並びます。Word/PDF/表紙をダウンロードし、
            メタデータをコピーして Amazon KDP に登録します。
          </Step>
        </div>
      </Section>

      {/* 3. 関門 */}
      <Section id="gates" title="3. 人が判断する 2 つの関門">
        <p>
          自動化されていますが、品質を担保するため人が必ず通す関門が 2 か所あります。
          ここで止まったまま進まない場合は、対象画面で承認操作をしてください。
        </p>
        <Card>
          <ul className="flex list-disc flex-col gap-2 pl-5">
            <li>
              <span className="font-medium text-foreground">アウトライン承認</span> —{' '}
              <Link href="/outlines" className="underline underline-offset-4 hover:no-underline">アウトライン承認</Link>
              画面。章立てを承認するまで本文執筆は始まりません。
            </li>
            <li>
              <span className="font-medium text-foreground">表紙(サムネ)採用</span> —{' '}
              <Link href="/covers" className="underline underline-offset-4 hover:no-underline">サムネ承認</Link>
              画面。3 候補から 1 枚を「採用」します。
            </li>
          </ul>
        </Card>
        <p className="text-button-sm text-muted">
          ※ テーマも「採用」して初めてバッチに乗るため、実質的にはテーマ選定も人の判断ポイントです。
        </p>
      </Section>

      {/* 4. 画面ごと */}
      <Section id="screens" title="4. 画面ごとの使い方">
        <div className="grid gap-space-snug md:grid-cols-2">
          <ScreenCard title="ホーム / ダッシュボード" href="/dashboard">
            進行中の本・承認待ち・今月のコスト・品質 KPI を一覧。まずここで全体状況を確認。
          </ScreenCard>
          <ScreenCard title="テーマ候補" href="/themes">
            マーケターにテーマを生成させ、採用/却下する。生成は 1〜2 分かかる。
          </ScreenCard>
          <ScreenCard title="新規プロジェクト / バッチ計画" href="/batches">
            採用テーマをまとめて執筆バッチ化し、実行する。
          </ScreenCard>
          <ScreenCard title="アウトライン承認" href="/outlines">
            章立てを確認して承認。承認後に本文執筆が走る (関門1)。
          </ScreenCard>
          <ScreenCard title="サムネ承認" href="/covers">
            表紙候補画像を見比べて 1 枚採用。各画像にコメントも付けられる (関門2)。
          </ScreenCard>
          <ScreenCard title="KDP 入稿" href="/kdp/checklist">
            完成本の入稿チェックリスト。値のコピー・Word/PDF/表紙のダウンロード・チェック管理。
          </ScreenCard>
          <ScreenCard title="書籍ライブラリ" href="/books">
            全書籍の一覧と詳細(章本文・評価履歴・コスト)。本文への修正コメントもここから。
          </ScreenCard>
          <ScreenCard title="修正コメント" href="/comments">
            付けた修正コメントを横断管理。優先度(must/should/may)の一括変更も可能。
          </ScreenCard>
          <ScreenCard title="修正一括反映" href="/revision-runs">
            溜めた修正コメントを編集者エージェントに一括で反映させる。
          </ScreenCard>
          <ScreenCard title="売上・KPI / コスト詳細" href="/sales">
            売上取得状況と KPI、API コストの内訳を確認。
          </ScreenCard>
          <ScreenCard title="モデル & プロンプト" href="/models/assignments">
            各工程に使う LLM モデルの割当・A/B 比較・プロンプト管理。
          </ScreenCard>
          <ScreenCard title="運用 (ジョブ/アラート/監査/設定)" href="/jobs">
            ジョブログで進行・失敗を確認、失敗は再実行できる。アカウントや各種設定もここ。
          </ScreenCard>
        </div>
      </Section>

      {/* 5. コメント */}
      <Section id="comments" title="5. 修正コメントと一括反映">
        <p>
          気になる箇所には「修正コメント」を付けられます。コメントは付けられる場所ごとにアイコン
          (＋コメント)が出ます。
        </p>
        <Card>
          <ul className="flex list-disc flex-col gap-2 pl-5">
            <li><span className="font-medium text-foreground">本文</span>: 書籍詳細の章ビューで段落ごとに付与</li>
            <li><span className="font-medium text-foreground">表紙</span>: サムネ承認画面で画像の気になる位置をクリックして付与</li>
            <li><span className="font-medium text-foreground">入稿メタデータ</span>: KDP 入稿チェックリストの各行「コメント」列から付与</li>
          </ul>
        </Card>
        <p>
          優先度は <Tag>must</Tag>(必須・入稿をブロック) / <Tag>should</Tag>(推奨) / <Tag>may</Tag>(任意)
          の 3 段階。must の未対応コメントがある本は入稿チェックリストでブロック表示されます。
          溜めたコメントは
          <Link href="/revision-runs" className="mx-1 underline underline-offset-4 hover:no-underline">修正一括反映</Link>
          で編集者にまとめて反映させ、再採点まで自動で回せます。
        </p>
      </Section>

      {/* 6. KDP */}
      <Section id="kdp" title="6. KDP への入稿手順">
        <div className="flex flex-col gap-space-relaxed">
          <Step n={1} title="入稿チェックリストを開く" href="/kdp/checklist">
            完成本(done)が並びます。左の本を選ぶと、表紙サムネと各メタデータが表示されます。
          </Step>
          <Step n={2} title="ファイルをダウンロード">
            「本文 URL」「カバー URL」行からダウンロード。本文は Word(docx)を推奨、PDF も出力済み。
          </Step>
          <Step n={3} title="メタデータをコピーして KDP に貼り付け">
            タイトル・紹介文・カテゴリ・キーワード・価格を各行のコピーボタンで取得し、
            右上「KDP を開く」から Amazon KDP の登録画面に貼り付けます。コピーした行は自動でチェックが付きます。
          </Step>
          <Step n={4} title="全項目チェックして入稿完了">
            すべてのチェックが付き、must コメントが残っていなければ入稿準備完了です。
          </Step>
        </div>
        <p className="text-button-sm text-muted">
          ※ KDP への自動入稿(ブラウザ自動操作)は今後のフェーズで対応予定。現状は手動入稿です。
        </p>
      </Section>

      {/* 7. コスト */}
      <Section id="cost" title="7. コスト・品質・トラブル時">
        <Card>
          <ul className="flex list-disc flex-col gap-2 pl-5">
            <li>
              <span className="font-medium text-foreground">コスト</span>: すべての AI 呼び出しは記録され、
              <Link href="/cost" className="mx-1 underline underline-offset-4 hover:no-underline">コスト詳細</Link>
              で確認できます。上部のコストメーターで今月の使用額が常時見えます。
            </li>
            <li>
              <span className="font-medium text-foreground">品質</span>: 品質ジャッジが 100 点満点で採点。
              低スコアや指摘は書籍詳細の評価履歴で確認し、修正コメント→一括反映で改善します。
            </li>
            <li>
              <span className="font-medium text-foreground">進まない / 失敗した</span>:{' '}
              <Link href="/jobs" className="underline underline-offset-4 hover:no-underline">ジョブログ</Link>
              で各工程の状態を確認。失敗ジョブは再実行できます。承認待ちで止まっている場合は関門 (第3章) を確認。
            </li>
            <li>
              <span className="font-medium text-foreground">テーマ生成が動かないように見える</span>:
              Web 検索のため 1〜2 分かかります。「生成中…」表示のまま待てば自動で候補が出ます。
            </li>
          </ul>
        </Card>
      </Section>
    </div>
  );
}

function ScreenCard({
  title,
  href,
  children,
}: {
  title: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-card border border-border-warm bg-cream-light p-space-relaxed">
      <Link
        href={href}
        className="text-body font-medium text-foreground underline underline-offset-4 hover:no-underline"
      >
        {title}
      </Link>
      <p className="text-button-sm text-charcoal-82">{children}</p>
    </div>
  );
}
