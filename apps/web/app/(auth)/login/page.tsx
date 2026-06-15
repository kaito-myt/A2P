/**
 * S-001 ログイン (docs/04 §S-001)
 *
 * - Header / Sidebar を持たない例外画面
 * - 中央カード: ブランド → ログインフォーム → フッター注記
 * - エラー文言 / ロック表示は LoginForm 内で表示
 *
 * デザイントークン基盤 (Tailwind / shadcn) は T-01-10 で導入予定。
 * 本タスクでは globals.css の CSS Variable (cream / charcoal / border-warm) を
 * 直接参照し、T-01-10 移行時に見た目を変えずに移行できる構造にしておく。
 */
import type { Metadata } from 'next';
import Image from 'next/image';
import { messages } from '@/lib/messages';
import { safeCallbackUrl } from '@/lib/url';
import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: `${messages.login.pageTitle} | ${messages.brand.appName}`,
};

interface PageProps {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const initialErrorCode = typeof params.error === 'string' ? params.error : null;
  // SSR でも safeCallbackUrl を通し、外部 URL を Client に渡さない。
  // 同一 origin 許可は Client 側で window.location.origin を使って二重に検証する。
  const callbackUrl = safeCallbackUrl(params.callbackUrl);

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '48px 24px',
      }}
    >
      <section
        aria-labelledby="login-heading"
        style={{
          width: '100%',
          maxWidth: 480,
          background: 'var(--color-cream-light)',
          border: '1px solid var(--color-border-warm)',
          borderRadius: 'var(--radius-card)',
          padding: '40px 32px',
          display: 'flex',
          flexDirection: 'column',
          gap: 32,
        }}
      >
        <header style={{ textAlign: 'center' }}>
          <h1
            id="login-heading"
            style={{
              margin: 0,
              display: 'flex',
              justifyContent: 'center',
            }}
          >
            <Image
              src="/logo.png"
              alt={messages.brand.appName}
              width={2508}
              height={627}
              priority
              sizes="280px"
              data-testid="login-brand-logo"
              style={{ width: 280, height: 'auto' }}
            />
          </h1>
          <p style={{ margin: '12px 0 0', color: 'var(--color-muted)', fontSize: 14 }}>
            {messages.brand.tagline}
          </p>
        </header>

        <LoginForm initialErrorCode={initialErrorCode} callbackUrl={callbackUrl} />

        <footer style={{ textAlign: 'center', color: 'var(--color-muted)', fontSize: 12 }}>
          <p style={{ margin: 0 }}>{messages.login.footerNote}</p>
          <p style={{ margin: '4px 0 0' }}>{messages.login.lockHint}</p>
        </footer>
      </section>
    </main>
  );
}
