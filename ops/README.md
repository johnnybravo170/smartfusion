# @heyhenry/ops

`ops.heyhenry.io` — HeyHenry's platform operations app. Work log, roadmap,
ideas, decisions, agent API. Admin-only, MFA-enforced, audited.

See `/OPS_PLAN.md` at the repo root for the architecture. This README is
the short-form runbook.

## Required env vars

```
NEXT_PUBLIC_SUPABASE_URL       # same as main app
NEXT_PUBLIC_SUPABASE_ANON_KEY  # same as main app
SUPABASE_SERVICE_ROLE_KEY      # same as main app (bypasses RLS)
OPS_KEY_PEPPER                 # 32+ bytes of random, NEW value specific to ops
OPS_ALERTS_FROM_EMAIL          # optional, default ops@mail.heyhenry.io
OPS_ALERTS_TO_EMAIL            # optional, default riffninjavideos@gmail.com
RESEND_API_KEY                 # required for alert sends + /api/ops/email/send
OPS_EMAIL_DEFAULT_FROM         # default `from` for /api/ops/email/send,
                               # e.g. "Hey Henry <ops@heyhenry.io>"
```

## Email sending

`POST /api/ops/email/send` (scope `write:email`) wraps Resend so Routines
and MCP callers can send transactional email without holding Resend
secrets themselves. The MCP tool equivalent is `ops_email_send`.

- `RESEND_API_KEY` — sending-only key, scoped to heyhenry.io domain.
- `OPS_EMAIL_DEFAULT_FROM` — default sender, e.g. `"Hey Henry <ops@heyhenry.io>"`.

`GET /api/ops/email/send` returns a small health snippet confirming
whether the env is configured (no key is leaked).

## Local dev

```bash
pnpm install
cd ops && pnpm dev     # runs on :3100 so it doesn't collide with :3000
```

## Deploy

Separate Vercel project. Repo: `johnnybravo170/smartfusion`. Root dir: `ops/`.
Domain: `ops.heyhenry.io`.

## API example

```bash
KEY="ops_<keyid>_<secret>"
TS=$(date +%s)
METHOD="POST"
PATH="/api/ops/worklog"
BODY='{"actor_name":"paperclip","title":"test","body":"hello"}'
BODY_SHA=$(printf '%s' "$BODY" | shasum -a 256 | awk '{print $1}')
SIG=$(printf '%s|%s|%s|%s' "$TS" "$METHOD" "$PATH" "$BODY_SHA" \
  | openssl dgst -sha256 -hmac "<secret>" -hex | awk '{print $2}')

curl -sS "https://ops.heyhenry.io$PATH" \
  -H "Authorization: Bearer $KEY" \
  -H "X-Ops-Timestamp: $TS" \
  -H "X-Ops-Signature: $SIG" \
  -H "Content-Type: application/json" \
  -d "$BODY"
```
