'use client';

/**
 * ApiCredentialsList — S-027 設定画面 API キー管理セクション (T-07-09, F-051/F-052).
 *
 * 4 行 (Anthropic / OpenAI / Google / Tavily): 状態バッジ + マスクプレビュー + Set/Test/Revoke。
 * - ApiCredentialModal: type="password" + provider別 prefix プレースホルダ + prefix 検証。
 * - ApiCredentialTestButton: testApiCredential SA 呼び出し → 結果バッジ。
 * - Revoke: confirm dialog → revokeApiCredential SA → env フォールバック警告バナー。
 * - 平文 API キーは絶対に画面に表示しない。
 */
import { useState, useCallback } from 'react';
import {
  CheckCircle,
  AlertTriangle,
  XCircle,
  Database,
  Key,
  Trash2,
  FlaskConical,
} from 'lucide-react';

import {
  setApiCredential,
  revokeApiCredential,
  testApiCredential,
} from '@/app/actions/api-credentials';
import { messages } from '@/lib/messages';
import type { ApiCredentialStatusRow, ApiProvider } from '@/lib/settings-view';

const m = messages.settings.sections.apiCredentials;

const PROVIDER_PREFIXES: Record<ApiProvider, { regex: RegExp; display: string }> = {
  anthropic: { regex: /^sk-ant-/, display: 'sk-ant-' },
  openai: { regex: /^sk-/, display: 'sk-' },
  google: { regex: /^AI/, display: 'AI' },
  tavily: { regex: /^tvly-/, display: 'tvly-' },
};

interface ApiCredentialsListProps {
  credentials: ApiCredentialStatusRow[];
}

export function ApiCredentialsList({ credentials }: ApiCredentialsListProps) {
  const [rows, setRows] = useState<ApiCredentialStatusRow[]>(credentials);
  const [modalOpen, setModalOpen] = useState<ApiProvider | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiProvider | null>(null);

  const handleSaved = useCallback((provider: ApiProvider, key_mask: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.provider === provider
          ? { ...r, status: 'db', key_mask, last_tested_at: null, last_test_ok: null, last_test_latency_ms: null }
          : r,
      ),
    );
    setModalOpen(null);
  }, []);

  const handleRevoked = useCallback((provider: ApiProvider) => {
    setRows((prev) =>
      prev.map((r) =>
        r.provider === provider
          ? { ...r, status: 'env', key_mask: null, last_tested_at: null, last_test_ok: null, last_test_latency_ms: null }
          : r,
      ),
    );
    setRevokeTarget(null);
  }, []);

  const handleTestResult = useCallback(
    (provider: ApiProvider, ok: boolean, latency_ms: number | null) => {
      const now = new Date().toISOString();
      setRows((prev) =>
        prev.map((r) =>
          r.provider === provider
            ? { ...r, last_tested_at: now, last_test_ok: ok, last_test_latency_ms: latency_ms }
            : r,
        ),
      );
    },
    [],
  );

  return (
    <section
      aria-labelledby="api-credentials-heading"
      className="rounded-card border border-border-warm bg-cream-light p-space-loose"
      data-testid="api-credentials-list"
    >
      <div className="mb-space-snug">
        <h2
          id="api-credentials-heading"
          className="text-sub-heading text-foreground"
        >
          {m.title}
        </h2>
        <p className="text-body text-muted">{m.subtitle}</p>
      </div>

      {/* env fallback warning banner */}
      {rows.some((r) => r.status === 'env') && (
        <div
          role="status"
          aria-live="polite"
          className="mb-space-snug flex items-start gap-2 rounded-button border border-amber-300 bg-amber-50 px-3 py-2 text-button-sm text-amber-800"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{m.envFallbackBanner}</span>
        </div>
      )}

      <div className="overflow-x-auto rounded-card border border-border-warm">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b border-border-warm bg-white text-left">
              <th className="px-space-relaxed py-space-snug font-medium text-charcoal">プロバイダ</th>
              <th className="px-space-relaxed py-space-snug font-medium text-charcoal">状態</th>
              <th className="px-space-relaxed py-space-snug font-medium text-charcoal">{m.maskedKeyLabel}</th>
              <th className="px-space-relaxed py-space-snug font-medium text-charcoal">最終テスト</th>
              <th className="px-space-relaxed py-space-snug text-right font-medium text-charcoal">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <CredentialRow
                key={row.provider}
                row={row}
                onSetClick={() => setModalOpen(row.provider)}
                onRevokeClick={() => setRevokeTarget(row.provider)}
                onTestResult={handleTestResult}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Set key modal */}
      {modalOpen !== null && (
        <ApiCredentialModal
          provider={modalOpen}
          onClose={() => setModalOpen(null)}
          onSaved={handleSaved}
        />
      )}

      {/* Revoke confirm dialog */}
      {revokeTarget !== null && (
        <RevokeConfirmDialog
          provider={revokeTarget}
          onCancel={() => setRevokeTarget(null)}
          onRevoked={handleRevoked}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// CredentialRow
// ---------------------------------------------------------------------------

function CredentialRow({
  row,
  onSetClick,
  onRevokeClick,
  onTestResult,
}: {
  row: ApiCredentialStatusRow;
  onSetClick: () => void;
  onRevokeClick: () => void;
  onTestResult: (provider: ApiProvider, ok: boolean, latency_ms: number | null) => void;
}) {
  const providerLabel = m.providers[row.provider] ?? row.provider;

  return (
    <tr className="border-b border-border-warm last:border-0" data-testid={`credential-row-${row.provider}`}>
      <td className="px-space-relaxed py-space-snug font-medium text-charcoal">
        {providerLabel}
      </td>
      <td className="px-space-relaxed py-space-snug">
        <StatusBadge status={row.status} />
      </td>
      <td className="px-space-relaxed py-space-snug font-mono text-button-sm text-muted">
        {row.key_mask ?? '—'}
      </td>
      <td className="px-space-relaxed py-space-snug text-button-sm text-muted">
        <TestResultCell row={row} />
      </td>
      <td className="px-space-relaxed py-space-snug">
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onSetClick}
            className="flex cursor-pointer items-center gap-1 rounded-button border border-border-warm bg-white px-3 py-1 text-button-sm text-charcoal hover:bg-cream-light focus-visible:ring-2 focus-visible:ring-foreground"
            aria-label={`${providerLabel} のキーを設定`}
          >
            <Key aria-hidden="true" className="h-3 w-3" />
            {m.setButton}
          </button>
          <ApiCredentialTestButton
            provider={row.provider}
            hasDbKey={row.status === 'db'}
            onTestResult={onTestResult}
          />
          {row.status === 'db' && (
            <button
              type="button"
              onClick={onRevokeClick}
              className="flex cursor-pointer items-center gap-1 rounded-button border border-destructive bg-white px-3 py-1 text-button-sm text-destructive hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-destructive"
              aria-label={`${providerLabel} のキーを削除`}
            >
              <Trash2 aria-hidden="true" className="h-3 w-3" />
              {m.revokeButton}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: ApiCredentialStatusRow['status'] }) {
  if (status === 'db') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-button-sm text-green-800">
        <Database aria-hidden="true" className="h-3 w-3" />
        {m.statusDb}
      </span>
    );
  }
  if (status === 'env') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-button-sm text-amber-800">
        <AlertTriangle aria-hidden="true" className="h-3 w-3" />
        {m.statusEnv}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-button-sm text-gray-600">
      <XCircle aria-hidden="true" className="h-3 w-3" />
      {m.statusUnset}
    </span>
  );
}

// ---------------------------------------------------------------------------
// TestResultCell
// ---------------------------------------------------------------------------

function TestResultCell({ row }: { row: ApiCredentialStatusRow }) {
  if (!row.last_tested_at) {
    return <span className="text-muted">{m.neverTested}</span>;
  }
  const date = new Date(row.last_tested_at);
  const formatted = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (row.last_test_ok === true) {
    return (
      <span className="flex items-center gap-1 text-green-700">
        <CheckCircle aria-hidden="true" className="h-3 w-3" />
        {m.testSuccessLatency(row.last_test_latency_ms ?? 0)}
        <span className="text-muted">({formatted})</span>
      </span>
    );
  }
  if (row.last_test_ok === false) {
    return (
      <span className="flex items-center gap-1 text-destructive">
        <XCircle aria-hidden="true" className="h-3 w-3" />
        <span className="text-muted">({formatted})</span>
      </span>
    );
  }
  return <span className="text-muted">{formatted}</span>;
}

// ---------------------------------------------------------------------------
// ApiCredentialTestButton (F-052)
// ---------------------------------------------------------------------------

function ApiCredentialTestButton({
  provider,
  hasDbKey,
  onTestResult,
}: {
  provider: ApiProvider;
  hasDbKey: boolean;
  onTestResult: (provider: ApiProvider, ok: boolean, latency_ms: number | null) => void;
}) {
  const [isPending, setIsPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const handleTest = useCallback(async () => {
    if (!hasDbKey) return;
    setIsPending(true);
    setResult(null);
    const res = await testApiCredential({ provider });
    setIsPending(false);
    if (res.ok) {
      const ok = res.data.ok;
      const latency = res.data.latency_ms ?? null;
      onTestResult(provider, ok, latency);
      if (ok) {
        setResult({ ok: true, msg: m.testSuccessLatency(latency ?? 0) });
      } else {
        setResult({ ok: false, msg: m.testFailureReason(res.data.message) });
      }
    } else {
      setResult({ ok: false, msg: res.error.message });
    }
  }, [provider, hasDbKey, onTestResult]);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={isPending || !hasDbKey}
        onClick={handleTest}
        title={hasDbKey ? undefined : '先にキーを設定してください'}
        className="flex cursor-pointer items-center gap-1 rounded-button border border-border-warm bg-white px-3 py-1 text-button-sm text-charcoal hover:bg-cream-light disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-foreground"
        aria-label={`${provider} 接続テスト`}
        data-testid={`test-button-${provider}`}
      >
        <FlaskConical aria-hidden="true" className="h-3 w-3" />
        {isPending ? m.testing : m.testButton}
      </button>
      {result && (
        <div
          role="status"
          aria-live="polite"
          className={`flex items-center gap-1 text-button-sm ${result.ok ? 'text-green-700' : 'text-destructive'}`}
        >
          {result.ok
            ? <CheckCircle aria-hidden="true" className="h-3 w-3" />
            : <XCircle aria-hidden="true" className="h-3 w-3" />}
          {result.msg}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ApiCredentialModal
// ---------------------------------------------------------------------------

function ApiCredentialModal({
  provider,
  onClose,
  onSaved,
}: {
  provider: ApiProvider;
  onClose: () => void;
  onSaved: (provider: ApiProvider, key_mask: string) => void;
}) {
  const [key, setKey] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const providerLabel = m.providers[provider] ?? provider;
  const prefix = PROVIDER_PREFIXES[provider];
  const placeholder = m.prefixPlaceholders[provider] ?? '';

  const validateKey = useCallback((val: string): string | null => {
    if (!val) return 'API キーを入力してください';
    if (!prefix.regex.test(val)) {
      return m.prefixError(providerLabel, prefix.display);
    }
    return null;
  }, [provider, prefix, providerLabel]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const err = validateKey(key);
    if (err) {
      setKeyError(err);
      return;
    }
    setIsPending(true);
    setFeedback(null);
    const result = await setApiCredential({ provider, key });
    setIsPending(false);
    if (result.ok) {
      onSaved(provider, result.data.key_mask);
    } else {
      setFeedback(result.error.message);
    }
  }, [key, provider, validateKey, onSaved]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="credential-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-card border border-border-warm bg-white p-space-loose shadow-lg">
        <h3
          id="credential-modal-title"
          className="mb-space-snug text-sub-heading text-foreground"
        >
          {m.modalTitle(providerLabel)}
        </h3>

        <form onSubmit={handleSubmit} className="flex flex-col gap-space-snug">
          <div className="flex flex-col gap-1">
            <label htmlFor="api-key-input" className="text-body font-medium text-charcoal">
              {m.modalKeyLabel}
            </label>
            <input
              id="api-key-input"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onBlur={() => setKeyError(validateKey(key))}
              placeholder={placeholder}
              className="rounded-button border border-border-warm bg-white px-3 py-2 text-body text-charcoal placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
            />
            {keyError && (
              <p role="alert" className="text-button-sm text-destructive">
                {keyError}
              </p>
            )}
          </div>

          {feedback && (
            <p role="alert" aria-live="polite" className="text-button-sm text-destructive">
              {feedback}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
              className="rounded-button border border-border-warm bg-cream-light px-4 py-2 text-button-sm text-charcoal hover:bg-charcoal-04 disabled:opacity-50"
            >
              {m.modalCancel}
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="rounded-button bg-foreground px-4 py-2 text-button-sm font-medium text-white disabled:opacity-50"
            >
              {isPending ? m.modalSubmitting : m.modalSubmit}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RevokeConfirmDialog
// ---------------------------------------------------------------------------

function RevokeConfirmDialog({
  provider,
  onCancel,
  onRevoked,
}: {
  provider: ApiProvider;
  onCancel: () => void;
  onRevoked: (provider: ApiProvider) => void;
}) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerLabel = m.providers[provider] ?? provider;

  const handleRevoke = useCallback(async () => {
    setIsPending(true);
    setError(null);
    const result = await revokeApiCredential({ provider });
    setIsPending(false);
    if (result.ok) {
      onRevoked(provider);
    } else {
      setError(result.error.message);
    }
  }, [provider, onRevoked]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="revoke-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="w-full max-w-sm rounded-card border border-border-warm bg-white p-space-loose shadow-lg">
        <h3
          id="revoke-dialog-title"
          className="mb-space-snug text-sub-heading text-foreground"
        >
          {m.revokeConfirmTitle}
        </h3>
        <p className="mb-space-snug text-body text-muted">
          {m.revokeConfirmBody}
        </p>
        <p className="mb-space-snug text-body font-medium text-charcoal">{providerLabel}</p>

        {error && (
          <p role="alert" className="mb-space-snug text-button-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="rounded-button border border-border-warm bg-cream-light px-4 py-2 text-button-sm text-charcoal hover:bg-charcoal-04 disabled:opacity-50"
          >
            {m.revokeConfirmNo}
          </button>
          <button
            type="button"
            onClick={handleRevoke}
            disabled={isPending}
            className="rounded-button border border-destructive bg-white px-4 py-2 text-button-sm font-medium text-destructive hover:bg-red-50 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-destructive"
          >
            {isPending ? '削除中...' : m.revokeConfirmYes}
          </button>
        </div>
      </div>
    </div>
  );
}
