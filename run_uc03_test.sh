#!/bin/bash
cd "C:\DEV\A2P"
echo "Running UC-03 E2E test..."
echo "Start time: $(date)"

pnpm exec playwright test uc03-prompt-optimizer.spec.ts --project=chromium

echo "End time: $(date)"
echo "Exit code: $?"
