#!/usr/bin/env tsx
/**
 * LLM クライアント (`AISdkClient`, `AgentSdkClient`) を `createAgentClient`
 * ファクトリ以外で直接 `new` していないかを CI で機械的に検証する。
 *
 * 規約: `docs/05 §10.1` / `CLAUDE.md` Hard Rule 5
 * - 唯一の正規生成経路は `packages/agents/src/lib/llm-client-factory.ts`
 * - 生インスタンス化を許すと `withTokenLogging` を迂回し `token_usage` 漏れが発生する
 *
 * Usage: `pnpm check:llm-client`
 * Exit:  0 = 違反なし / 1 = 違反あり
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const SCAN_ROOTS = ['apps', 'packages'];
const FILE_EXTENSIONS = new Set(['.ts', '.tsx']);

// パスは POSIX 形式 ('/') で比較する。Windows でも常に '/' に正規化。
const ALLOW_FILES = new Set([
  'packages/agents/src/lib/llm-client-factory.ts',
  'packages/agents/src/lib/ai-sdk-client.ts',
  'packages/agents/src/lib/agent-sdk-client.ts',
]);

const ALLOW_DIR_PATTERNS = [
  /(^|\/)__tests__(\/|$)/,
  /(^|\/)tests\/e2e(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)coverage(\/|$)/,
  /(^|\/)generated(\/|$)/,
];

// 個別 allow コメント (拡張余地)
const INLINE_ALLOW = /\/\/\s*llm-client-guard:allow\b/;

const VIOLATION_PATTERN = /new\s+(AISdkClient|AgentSdkClient)\s*\(/;

interface Violation {
  file: string; // POSIX 相対パス
  line: number;
  content: string;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function isAllowedPath(posixRelPath: string): boolean {
  if (ALLOW_FILES.has(posixRelPath)) return true;
  return ALLOW_DIR_PATTERNS.some((re) => re.test(posixRelPath));
}

function walk(dirAbs: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dirAbs);
  } catch {
    return;
  }
  for (const name of entries) {
    const childAbs = resolve(dirAbs, name);
    const rel = toPosix(relative(repoRoot, childAbs));
    let stat;
    try {
      stat = statSync(childAbs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      // ディレクトリレベルで早期スキップ (大きな node_modules / dist / .next を歩かない)
      if (ALLOW_DIR_PATTERNS.some((re) => re.test(rel + '/'))) continue;
      walk(childAbs, out);
    } else if (stat.isFile()) {
      const dotIdx = name.lastIndexOf('.');
      if (dotIdx < 0) continue;
      const ext = name.slice(dotIdx);
      if (!FILE_EXTENSIONS.has(ext)) continue;
      out.push(childAbs);
    }
  }
}

function scanFile(absPath: string): Violation[] {
  const posixRel = toPosix(relative(repoRoot, absPath));
  if (isAllowedPath(posixRel)) return [];

  let raw: string;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/);
  const found: Violation[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!VIOLATION_PATTERN.test(line)) continue;
    if (INLINE_ALLOW.test(line)) continue;
    found.push({ file: posixRel, line: i + 1, content: line.trim() });
  }
  return found;
}

function main(): void {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    walk(resolve(repoRoot, root), files);
  }

  const violations: Violation[] = [];
  for (const abs of files) {
    violations.push(...scanFile(abs));
  }

  if (violations.length > 0) {
    console.error(
      `[check-llm-client] FAIL: ${violations.length} raw LLM client instantiation(s) found outside the factory:`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}: ${v.content}`);
    }
    console.error(
      `\n  Fix: use \`createAgentClient(role, genre, ctx)\` from \`packages/agents/src/lib/llm-client-factory.ts\`.`,
    );
    console.error(
      `  Allowed exceptions: factory itself, class definition files, \`__tests__/\` and \`tests/e2e/\` directories.`,
    );
    console.error(
      `  Per-line escape hatch: append \`// llm-client-guard:allow\` (use sparingly, with justification).`,
    );
    process.exit(1);
  }

  console.log(
    `[check-llm-client] OK: no raw LLM client instantiations outside factory (scanned ${files.length} files).`,
  );
}

main();
