#!/usr/bin/env tsx
/**
 * `.env.example` のキー集合と `packages/contracts/src/env.ts` の zod スキーマの
 * キー集合が完全一致しているかを検証する CI スクリプト。
 *
 * Usage: `tsx scripts/check-env-example.ts`
 * Exit code: 0 = 一致 / 1 = 不一致
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV_KEYS } from '../packages/contracts/src/env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const envExamplePath = resolve(repoRoot, '.env.example');

function extractKeysFromEnvFile(path: string): string[] {
  const raw = readFileSync(path, 'utf8');
  const keys: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    if (/^[A-Z_][A-Z0-9_]*$/.test(key)) keys.push(key);
  }
  return keys;
}

const envExampleKeys = extractKeysFromEnvFile(envExamplePath);
const schemaKeys = ENV_KEYS as readonly string[];

const envExampleSet = new Set(envExampleKeys);
const schemaSet = new Set(schemaKeys);

const missingInExample = schemaKeys.filter((k) => !envExampleSet.has(k));
const extraInExample = envExampleKeys.filter((k) => !schemaSet.has(k));
const duplicatesInExample = envExampleKeys.filter((k, i) => envExampleKeys.indexOf(k) !== i);

let ok = true;

if (missingInExample.length > 0) {
  ok = false;
  console.error(`[check-env-example] Missing in .env.example (${missingInExample.length}):`);
  for (const k of missingInExample) console.error(`  - ${k}`);
}

if (extraInExample.length > 0) {
  ok = false;
  console.error(`[check-env-example] Extra in .env.example not in schema (${extraInExample.length}):`);
  for (const k of extraInExample) console.error(`  - ${k}`);
}

if (duplicatesInExample.length > 0) {
  ok = false;
  console.error(`[check-env-example] Duplicate keys in .env.example:`);
  for (const k of [...new Set(duplicatesInExample)]) console.error(`  - ${k}`);
}

if (!ok) {
  console.error(
    `\n[check-env-example] FAIL: .env.example (${envExampleKeys.length} keys) and EnvSchema (${schemaKeys.length} keys) diverge.`,
  );
  process.exit(1);
}

console.log(
  `[check-env-example] OK: .env.example and EnvSchema both define the same ${schemaKeys.length} keys.`,
);
