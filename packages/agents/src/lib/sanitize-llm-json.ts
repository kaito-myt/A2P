/**
 * LLM 応答の JSON を通すためのサニタイザ。
 *
 * LLM は JSON 文字列値の中に「生の改行/タブ」や「エスケープされていない二重引用符」
 * （例: `"subtitle": "平安の"陽キャ"がSNS全開で語る"`）を出しがちで、素の JSON.parse を壊す。
 * ここでは 1 パスで、文字列リテラル内の
 *   - 生の改行/復帰/タブ → \n \r \t にエスケープ
 *   - 構造的でない（＝リテラルの）二重引用符 → \" にエスケープ
 * を行い、パース可能な JSON 文字列へ寄せる。
 *
 * 「構造的な閉じ引用符かリテラルか」は先読みで判定する: 直後（空白を飛ばして）が
 * `, } ] :` もしくは末尾なら閉じ引用符、それ以外は文字列中のリテラル引用符とみなす。
 * 正しくエスケープ済みの有効な JSON に対しては何も変えない（冪等・非破壊）。
 */

const STRUCTURAL_AFTER = new Set([',', '}', ']', ':']);

function nextNonSpace(text: string, from: number): string | null {
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    return c;
  }
  return null; // 末尾
}

export function sanitizeLlmJson(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (escaped) {
      // 直前が \ の文字はそのまま（既にエスケープ済み）。
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }

    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }

    // --- 文字列リテラル内 ---
    if (ch === '\n') {
      out += '\\n';
      continue;
    }
    if (ch === '\r') {
      out += '\\r';
      continue;
    }
    if (ch === '\t') {
      out += '\\t';
      continue;
    }
    if (ch === '"') {
      // 構造的な閉じ引用符か、リテラルの引用符か。
      const after = nextNonSpace(text, i + 1);
      if (after === null || STRUCTURAL_AFTER.has(after)) {
        out += '"'; // 閉じる
        inString = false;
      } else {
        out += '\\"'; // 文字列中のリテラル引用符 → エスケープ
      }
      continue;
    }
    out += ch;
  }

  return out;
}

/**
 * LLM のテキスト応答から JSON を抽出してパースする（堅牢版）。
 * ```json フェンス / 前後の散文 / 生改行 / 未エスケープ引用符 を許容する。
 *
 * @param predicate 期待する形かを判定（複数候補から選ぶ）。無指定なら最大のオブジェクトを返す。
 * @returns パースできた値、できなければ undefined
 */
export function extractLlmJson<T = unknown>(
  text: string,
  predicate?: (parsed: unknown) => boolean,
): T | undefined {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) return undefined;

  const candidates: unknown[] = [];
  const push = (s: string) => {
    const v = tryParseWithRepair(s);
    if (v !== undefined) candidates.push(v);
  };

  // 1. そのまま
  push(trimmed);

  // 2. ```json フェンス内
  const fenceRe = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(trimmed)) !== null) {
    const body = m[1]?.trim();
    if (body) {
      push(body);
      collectBalanced(body, push);
    }
  }

  // 3. 最初の { 〜 対応する } を総当り
  collectBalanced(trimmed, push);

  if (predicate) {
    for (const c of candidates) if (predicate(c)) return c as T;
    return undefined;
  }
  // 最大のオブジェクトを返す
  let best: unknown;
  let bestSize = -1;
  for (const c of candidates) {
    if (typeof c === 'object' && c !== null) {
      const size = JSON.stringify(c).length;
      if (size > bestSize) {
        best = c;
        bestSize = size;
      }
    }
  }
  return best as T | undefined;
}

function tryParseWithRepair(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    try {
      return JSON.parse(sanitizeLlmJson(s));
    } catch {
      return undefined;
    }
  }
}

function collectBalanced(text: string, push: (s: string) => void): void {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    const end = findMatchingBrace(text, start);
    if (end !== -1) push(text.slice(start, end + 1));
  }
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}
