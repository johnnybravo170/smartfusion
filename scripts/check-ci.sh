#!/bin/bash
# Check GitHub Actions CI status for the latest commit
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[ci-check] Checking latest CI run..."
STATUS=$(gh run list --limit 1 --json status,conclusion --jq '.[0] | "\(.status) \(.conclusion)"' 2>/dev/null || echo "unknown")
echo "[ci-check] Latest: $STATUS"

if [[ "$STATUS" == *"failure"* ]]; then
  echo "[ci-check] CI failed. Fetching logs..."
  RUN_ID=$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')
  gh run view "$RUN_ID" --log-failed 2>&1 | tail -40
  exit 1
fi

echo "[ci-check] CI green."
