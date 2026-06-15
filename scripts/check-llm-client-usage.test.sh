#!/usr/bin/env bash
# Verification harness for `scripts/check-llm-client-usage.ts`.
#
# - Case 1: current tree must pass (exit 0)
# - Case 2: temporarily writing a violation under `apps/web/lib/__bad-test__.ts`
#           must trigger exit 1 and print the offending file:line
# - Case 3: removing the file must restore exit 0
#
# Run from repo root:  bash scripts/check-llm-client-usage.test.sh
# Exit: 0 = all cases ok, 1 = some case failed.

set -u
cd "$(dirname "$0")/.."

BAD_FILE="apps/web/lib/__bad-test__.ts"
FAIL=0

cleanup() {
  rm -f "$BAD_FILE"
}
trap cleanup EXIT

run_check() {
  pnpm --silent check:llm-client 2>&1
}

# --- Case 1: clean tree ---
echo "[case 1] clean tree should exit 0"
out=$(run_check)
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "FAIL: expected exit 0, got $rc"
  echo "$out"
  FAIL=1
else
  echo "ok"
fi

# --- Case 2: inject violation ---
echo "[case 2] injected violation should exit 1 and reference the bad file"
cat >"$BAD_FILE" <<'EOF'
import { AISdkClient } from '@a2p/agents/src/lib/ai-sdk-client';
export const _bad = new AISdkClient({ provider: 'openai', model: 'm', apiKey: 'k' });
EOF
out=$(run_check)
rc=$?
if [ "$rc" -eq 0 ]; then
  echo "FAIL: expected exit 1, got 0"
  echo "$out"
  FAIL=1
elif ! echo "$out" | grep -q "apps/web/lib/__bad-test__.ts:2"; then
  echo "FAIL: expected violation to reference apps/web/lib/__bad-test__.ts:2"
  echo "$out"
  FAIL=1
else
  echo "ok"
fi

# --- Case 3: remove violation ---
echo "[case 3] removing violation should exit 0 again"
rm -f "$BAD_FILE"
out=$(run_check)
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "FAIL: expected exit 0, got $rc"
  echo "$out"
  FAIL=1
else
  echo "ok"
fi

if [ "$FAIL" -eq 0 ]; then
  echo "[check-llm-client.test] ALL PASS"
  exit 0
fi
echo "[check-llm-client.test] SOME FAILED"
exit 1
