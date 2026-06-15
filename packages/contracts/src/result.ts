/**
 * Server Actions / Route Handlers の戻り値標準型 (docs/05 §9.2)
 *
 * UI 層は `result.ok` で分岐する。失敗時は `result.error.code` で
 * トースト/フィールドエラーの出し分けを行う。`details` は任意。
 */

export type ActionOk<T> = { ok: true; data: T };
export type ActionFail = {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type ActionResult<T> = ActionOk<T> | ActionFail;

/** 成功結果を生成する。 */
export function ok<T>(data: T): ActionOk<T> {
  return { ok: true, data };
}

/** 失敗結果を生成する。 */
export function fail(code: string, message: string, details?: unknown): ActionFail {
  const error: ActionFail['error'] =
    details === undefined ? { code, message } : { code, message, details };
  return { ok: false, error };
}

/** 型ガード: ActionResult が成功か。 */
export function isOk<T>(r: ActionResult<T>): r is ActionOk<T> {
  return r.ok === true;
}

/** 型ガード: ActionResult が失敗か。 */
export function isFail<T>(r: ActionResult<T>): r is ActionFail {
  return r.ok === false;
}
