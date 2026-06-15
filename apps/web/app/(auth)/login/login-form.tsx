'use client';

import { useState, useTransition, useId } from 'react';
import { signIn } from 'next-auth/react';
import { messages } from '@/lib/messages';
import { safeCallbackUrl } from '@/lib/url';

interface DecodedError {
  text: string;
}

/**
 * authorize() で throw した CredentialsSignin の `code` を UI 表示用文言に変換。
 * フォーマット:
 *   - `invalid_credentials:<remaining>` … 残り試行回数
 *   - `locked:<ISO unlockAt>`           … 残り MM:SS
 *   - `missing_fields`
 *   - 上記以外 → unexpected
 */
function decodeError(code: string | null, now: Date = new Date()): DecodedError | null {
  if (!code) return null;
  if (code === 'missing_fields') return { text: messages.login.errors.missingFields };
  if (code.startsWith('invalid_credentials:')) {
    const rest = code.slice('invalid_credentials:'.length);
    const remaining = Number.parseInt(rest, 10);
    if (Number.isFinite(remaining) && remaining > 0) {
      return { text: messages.login.errors.invalidCredentialsWithRemaining(remaining) };
    }
    return { text: messages.login.errors.invalidCredentials };
  }
  if (code.startsWith('locked:')) {
    const iso = code.slice('locked:'.length);
    const unlockAt = new Date(iso);
    if (!Number.isNaN(unlockAt.getTime())) {
      const remainMs = Math.max(0, unlockAt.getTime() - now.getTime());
      const totalSec = Math.ceil(remainMs / 1000);
      const mm = Math.floor(totalSec / 60).toString().padStart(2, '0');
      const ss = (totalSec % 60).toString().padStart(2, '0');
      return { text: messages.login.errors.locked(`${mm}:${ss}`) };
    }
  }
  return { text: messages.login.errors.unexpected };
}

interface LoginFormProps {
  initialErrorCode: string | null;
  callbackUrl: string;
}

export function LoginForm({ initialErrorCode, callbackUrl }: LoginFormProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(initialErrorCode);
  const [isPending, startTransition] = useTransition();

  const usernameId = useId();
  const passwordId = useId();

  const error = decodeError(errorCode);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorCode(null);
    startTransition(async () => {
      try {
        const result = await signIn('credentials', {
          username,
          password,
          redirect: false,
        });
        // Auth.js v5: result.error には CredentialsSignin code が入る
        if (result?.error) {
          // result.code (next-auth v5 beta) または result.error を使用
          const code =
            (result as { code?: string }).code ??
            (result.error === 'CredentialsSignin' ? 'invalid_credentials:' : result.error);
          setErrorCode(code);
          return;
        }
        // 成功 → callbackUrl へ遷移。オープンリダイレクト防止のため必ず同一 origin に絞る
        const safeUrl = safeCallbackUrl(callbackUrl, {
          allowedOrigin: window.location.origin,
        });
        window.location.assign(safeUrl);
      } catch (err) {
        // ネットワーク等の予期しない失敗
        // TODO: replace with structured client logger after SP-07 logging baseline
        console.error('[login] unexpected', err);
        setErrorCode('unexpected');
      }
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label={messages.login.pageTitle}
      style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}
    >
      {error && (
        <div
          role="alert"
          aria-live="polite"
          data-testid="login-error"
          style={{
            padding: '12px 14px',
            borderRadius: 'var(--radius-default)',
            background: 'var(--color-destructive-bg)',
            color: 'var(--color-destructive)',
            fontSize: 14,
            border: '1px solid var(--color-destructive)',
          }}
        >
          {error.text}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor={usernameId} style={{ fontSize: 14, color: 'var(--color-charcoal-82)' }}>
          {messages.login.usernameLabel}
        </label>
        <input
          id={usernameId}
          name="username"
          type="text"
          autoComplete="username"
          required
          disabled={isPending}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          data-testid="login-username"
          style={inputStyle}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label htmlFor={passwordId} style={{ fontSize: 14, color: 'var(--color-charcoal-82)' }}>
          {messages.login.passwordLabel}
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            id={passwordId}
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            required
            disabled={isPending}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-testid="login-password"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            type="button"
            aria-pressed={showPassword}
            onClick={() => setShowPassword((v) => !v)}
            disabled={isPending}
            style={ghostButtonStyle}
          >
            {showPassword ? messages.login.hidePassword : messages.login.showPassword}
          </button>
        </div>
      </div>

      <button
        type="submit"
        disabled={isPending}
        data-testid="login-submit"
        style={primaryButtonStyle}
      >
        {isPending ? messages.login.submitting : messages.login.submit}
      </button>
    </form>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  border: '1px solid var(--color-border-warm)',
  borderRadius: 'var(--radius-default)',
  background: 'var(--color-cream-light)',
  color: 'var(--color-charcoal)',
  fontSize: 16,
  outline: 'none',
};

const primaryButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 16px',
  borderRadius: 'var(--radius-default)',
  background: 'var(--color-charcoal)',
  color: 'var(--color-cream-light)',
  border: 'none',
  fontSize: 16,
  fontWeight: 500,
};

const ghostButtonStyle: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: 'var(--radius-default)',
  background: 'transparent',
  color: 'var(--color-charcoal)',
  border: '1px solid var(--color-charcoal-40)',
  fontSize: 14,
};
