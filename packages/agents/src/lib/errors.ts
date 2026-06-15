/**
 * docs/03 §A-04 / docs/05 §6.1.1 — プロバイダ別エラー判定の共通ロジック。
 * AISdkClient / AgentSdkClient 双方の p-retry ハンドラから利用する。
 */

export type ProviderErrorKind =
  | 'rate_limit'
  | 'server_error'
  | 'client_error'
  | 'network'
  | 'unknown';

export interface ClassifiedProviderError {
  /** HTTP ステータス (取れた場合のみ)。 */
  status?: number;
  /** リトライ判定に使うカテゴリ。 */
  kind: ProviderErrorKind;
  /** 元エラーから抽出した人間可読メッセージ。 */
  message: string;
}

type MaybeErrorShape = {
  name?: unknown;
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  message?: unknown;
  response?: { status?: unknown; statusCode?: unknown } | null | undefined;
  cause?: unknown;
};

function readStatus(err: MaybeErrorShape): number | undefined {
  const direct = err.status ?? err.statusCode;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const fromResponse = err.response?.status ?? err.response?.statusCode;
  if (typeof fromResponse === 'number' && Number.isFinite(fromResponse)) {
    return fromResponse;
  }
  // AI SDK は APICallError.statusCode / responseHeaders を持つことがある
  if (typeof err.code === 'number' && Number.isFinite(err.code)) return err.code;
  return undefined;
}

function isLikelyNetworkError(err: MaybeErrorShape): boolean {
  const code = typeof err.code === 'string' ? err.code : '';
  const name = typeof err.name === 'string' ? err.name : '';
  if (name === 'AbortError') return false;
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'ENOTFOUND' ||
    code === 'UND_ERR_SOCKET' ||
    name === 'FetchError' ||
    name === 'TypeError' // fetch() の 'fetch failed' は TypeError として出ることがある
  );
}

/** 任意の throw 値を retry 判定可能な形に正規化する。 */
export function classifyProviderError(err: unknown): ClassifiedProviderError {
  if (err == null || typeof err !== 'object') {
    return { kind: 'unknown', message: String(err) };
  }
  const e = err as MaybeErrorShape;
  const message = typeof e.message === 'string' ? e.message : String(err);
  const status = readStatus(e);

  if (status === 429) return { status, kind: 'rate_limit', message };
  if (typeof status === 'number') {
    if (status >= 500 && status < 600) {
      return { status, kind: 'server_error', message };
    }
    if (status >= 400 && status < 500) {
      return { status, kind: 'client_error', message };
    }
  }
  if (isLikelyNetworkError(e)) return { kind: 'network', message };

  // cause チェーンを 1 段だけ追跡 (AI SDK は APICallError({cause}) ラップが多い)
  if (e.cause && typeof e.cause === 'object') {
    const inner = classifyProviderError(e.cause);
    if (inner.kind !== 'unknown') return inner;
  }

  return { kind: 'unknown', message };
}

/** classifyProviderError の結果から「これ以上リトライすべきでないか」を判定する。 */
export function isNonRetryable(kind: ProviderErrorKind): boolean {
  return kind === 'client_error';
}
