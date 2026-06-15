import { describe, expect, it } from 'vitest';
import {
  A2PError,
  AgentError,
  AuthError,
  ConfigError,
  ConflictError,
  ForbiddenError,
  KdpError,
  NotFoundError,
  PipelineError,
  ProviderError,
  RateLimitError,
  StorageError,
  ValidationError,
  isA2PError,
} from '../src/errors.js';

describe('A2PError 派生', () => {
  const cases: Array<{
    cls: new (m: string) => A2PError;
    code: string;
    httpStatus: number;
    retryable: boolean;
  }> = [
    { cls: ValidationError, code: 'validation', httpStatus: 400, retryable: false },
    { cls: AuthError, code: 'auth', httpStatus: 401, retryable: false },
    { cls: ForbiddenError, code: 'forbidden', httpStatus: 403, retryable: false },
    { cls: NotFoundError, code: 'not_found', httpStatus: 404, retryable: false },
    { cls: ConflictError, code: 'conflict', httpStatus: 409, retryable: false },
    { cls: RateLimitError, code: 'rate_limit', httpStatus: 429, retryable: true },
    { cls: ProviderError, code: 'provider', httpStatus: 502, retryable: true },
    { cls: PipelineError, code: 'pipeline', httpStatus: 500, retryable: true },
    { cls: AgentError, code: 'agent', httpStatus: 500, retryable: true },
    { cls: ConfigError, code: 'config', httpStatus: 500, retryable: false },
    { cls: StorageError, code: 'storage', httpStatus: 502, retryable: true },
    { cls: KdpError, code: 'kdp', httpStatus: 502, retryable: true },
  ];

  for (const { cls, code, httpStatus, retryable } of cases) {
    it(`${cls.name}: code=${code} httpStatus=${httpStatus} retryable=${String(retryable)}`, () => {
      const err = new cls('boom');
      expect(err).toBeInstanceOf(A2PError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.httpStatus).toBe(httpStatus);
      expect(err.retryable).toBe(retryable);
      expect(err.message).toBe('boom');
      expect(err.name).toBe(cls.name);
    });
  }

  it('isA2PError 型ガードが派生型 / 非 A2P を正しく判定する', () => {
    expect(isA2PError(new ValidationError('x'))).toBe(true);
    expect(isA2PError(new KdpError('x'))).toBe(true);
    expect(isA2PError(new Error('plain'))).toBe(false);
    expect(isA2PError(null)).toBe(false);
    expect(isA2PError({ code: 'validation' })).toBe(false);
  });

  it('options.details / options.userMessage / options.cause を保持する', () => {
    const cause = new Error('upstream');
    const err = new ValidationError('invalid input', {
      userMessage: '入力値が不正です',
      details: { field: 'title' },
      cause,
    });
    expect(err.userMessage).toBe('入力値が不正です');
    expect(err.details).toEqual({ field: 'title' });
    expect(err.cause).toBe(cause);
  });

  it('ProviderError は options.retryable で false を指定できる', () => {
    const err = new ProviderError('400 bad request', { retryable: false });
    expect(err.retryable).toBe(false);
    expect(err.code).toBe('provider');
  });
});

describe('A2PError#toActionResult', () => {
  it('userMessage があれば message に採用する', () => {
    const err = new ConflictError('row locked', {
      userMessage: '他の処理が編集中です',
      details: { bookId: 'b_1' },
    });
    const r = err.toActionResult();
    expect(r.ok).toBe(false);
    expect(r.error).toEqual({
      code: 'conflict',
      message: '他の処理が編集中です',
      details: { bookId: 'b_1' },
    });
  });

  it('userMessage が無ければ Error#message を流用する', () => {
    const err = new NotFoundError('book not found');
    const r = err.toActionResult();
    expect(r.error.code).toBe('not_found');
    expect(r.error.message).toBe('book not found');
    expect(r.error.details).toBeUndefined();
  });
});

describe('A2PError#toJSON', () => {
  it('機密を含まない構造化オブジェクトに変換する', () => {
    const err = new StorageError('R2 PUT failed', {
      userMessage: 'ファイル保存に失敗しました',
      details: { bucket: 'a2p-artifacts', key: 'books/b_1/x.docx' },
    });
    expect(err.toJSON()).toEqual({
      name: 'StorageError',
      code: 'storage',
      httpStatus: 502,
      retryable: true,
      message: 'R2 PUT failed',
      userMessage: 'ファイル保存に失敗しました',
      details: { bucket: 'a2p-artifacts', key: 'books/b_1/x.docx' },
    });
  });
});
