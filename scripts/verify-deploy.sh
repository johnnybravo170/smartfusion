#!/bin/bash
# Verify Vercel deployment after push
# Reads VERCEL_TOKEN from .env.local
set -euo pipefail

cd "$(dirname "$0")/.."

VERCEL_TOKEN=$(grep '^VERCEL_TOKEN=' .env.local | cut -d= -f2)
APP_URL="https://app.heyhenry.io"
MAX_WAIT=180

echo "[deploy-check] Waiting for Vercel deployment..."

for i in $(seq 1 $((MAX_WAIT / 5))); do
  RESPONSE=$(curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v6/deployments?limit=1&teamId=johnnybravo170s-projects" 2>/dev/null)

  STATE=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['deployments'][0]['state'])" 2>/dev/null || echo "UNKNOWN")

  if [ "$STATE" = "READY" ]; then
    echo "[deploy-check] Deployment READY"
    break
  elif [ "$STATE" = "ERROR" ] || [ "$STATE" = "CANCELED" ]; then
    echo "[deploy-check] Deployment FAILED (state: $STATE)"
    DEP_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['deployments'][0]['uid'])" 2>/dev/null)

    echo "[deploy-check] Build log for $DEP_ID:"
    curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
      "https://api.vercel.com/v3/deployments/$DEP_ID/events?builds=1&direction=backward&limit=100" | \
      python3 -c "
import sys, json
events = json.load(sys.stdin)
for e in events:
    text = e.get('text','')
    if text.strip():
        print(text.strip())
" 2>/dev/null | tail -30
    exit 1
  fi

  echo "[deploy-check] State: $STATE, waiting... ($((i * 5))s / ${MAX_WAIT}s)"
  sleep 5
done

if [ "$STATE" != "READY" ]; then
  echo "[deploy-check] Timed out after ${MAX_WAIT}s (last state: $STATE)"
  exit 1
fi

echo "[deploy-check] Running health check..."
HEALTH=$(curl -s --max-time 10 "$APP_URL/api/health" 2>/dev/null || echo '{"status":"unreachable"}')
if echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['status']=='ok'" 2>/dev/null; then
  echo "[deploy-check] Health check passed: $HEALTH"
else
  echo "[deploy-check] Health check failed: $HEALTH"
  exit 1
fi

echo "[deploy-check] All good."
