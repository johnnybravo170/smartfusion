#!/bin/bash
# Combined health monitor for HeyHenry
# Checks: CI status, Vercel deploy, health endpoint, DB connectivity
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== HeyHenry Health Monitor ==="
echo "$(date)"
echo ""

# 1. CI status
bash scripts/check-ci.sh
echo ""

# 2. Vercel deploy status
source .env.local 2>/dev/null || true
VERCEL_TOKEN=${VERCEL_TOKEN:-}
if [ -n "$VERCEL_TOKEN" ]; then
  STATE=$(curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
    "https://api.vercel.com/v6/deployments?limit=1&teamId=johnnybravo170s-projects" | \
    python3 -c "
import sys, json
d = json.load(sys.stdin)['deployments'][0]
msg = d.get('meta', {}).get('githubCommitMessage', '')[:50]
print(f\"{d['state']} ({msg})\")
" 2>/dev/null || echo "ERROR fetching deploy status")
  echo "[vercel] Latest deployment: $STATE"
else
  echo "[vercel] VERCEL_TOKEN not set, skipping"
fi
echo ""

# 3. Health endpoint
HEALTH=$(curl -s --max-time 10 "https://app.heyhenry.io/api/health" 2>/dev/null || echo '{"status":"unreachable"}')
if echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['status']=='ok'" 2>/dev/null; then
  echo "[health] OK: $HEALTH"
else
  echo "[health] FAILED: $HEALTH"
fi
echo ""

# 4. Supabase connectivity
if grep -q '^DATABASE_URL=' .env.local 2>/dev/null; then
  DB_CHECK=$(node -e "
const postgres = require('postgres');
const fs = require('fs');
const url = fs.readFileSync('.env.local','utf8').match(/^DATABASE_URL=(.+)$/m)[1];
const sql = postgres(url, {max:1, idle_timeout:2, connect_timeout:5, prepare:false});
sql\`select count(*) as n from tenants\`.then(r => { console.log('ok, ' + r[0].n + ' tenants'); process.exit(0); }).catch(e => { console.log('error: ' + e.message); process.exit(1); });
" 2>&1 || echo "error running DB check")
  echo "[db] $DB_CHECK"
else
  echo "[db] DATABASE_URL not set, skipping"
fi

echo ""
echo "=== Done ==="
