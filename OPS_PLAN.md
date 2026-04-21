# Platform Ops (`ops.heyhenry.io`) — Build Plan

<!-- STATUS: Phase 0 (foundation) — NOT STARTED | Phase 1+ sketched -->

HeyHenry's internal operating system. Lives on a dedicated subdomain
`ops.heyhenry.io`. Single source of truth for the HeyHenry **business**
itself — work log, product roadmap, marketing roadmap, ideas,
decisions, and eventually its own analytics modules (SEO, email
attribution, revenue, ad spend). Scoped to platform admins and
authorized agents only. Zero overlap with contractor tenant data.

## Why this exists

- Cloud-native AI agents (Paperclip and friends) need a way to log
  what they did, read the current state of play, pick up the next
  assignment, and update status — from anywhere, securely.
- HenryOS (on the Mac Mini at port 7100) has all this already but is
  unreachable from cloud agents without tunneling, and is being
  narrowed to the PG / RN guitar businesses going forward.
- Keeping the two systems cleanly separated keeps the roles clear:
  HenryOS = guitar. `ops.heyhenry.io` = HeyHenry as a business.

## Boundary decisions

1. **Separate Postgres schema.** All tables live in `ops.*` inside the
   existing Supabase project (ca-central-1). Not `public.*`. Tenant
   RLS has no way to reach them; agent keys have no way to reach
   tenant data. DB-level separation is the first line of defense.
2. **Dedicated subdomain.** `ops.heyhenry.io`. Same Next.js codebase,
   host-based routing in middleware. Separate cookie scope prevents
   session bleed. Upgradeable to a separate Vercel project later
   without code churn.
3. **No `tenant_id` column anywhere in `ops.*`.** Removes the entire
   class of accidental tenant-scope leaks. Access is admin whitelist
   or API-key-scoped.
4. **Humans vs agents auth paths are distinct.** Humans use Supabase
   session + MFA; agents use API keys + HMAC. Neither can impersonate
   the other.

## Security model (non-negotiable)

### Authentication

- **Humans.** Supabase auth as today, plus:
  - `ops.admins` whitelist (just Jonathan at launch). Middleware on
    every route under `ops.heyhenry.io` enforces membership.
  - **TOTP MFA enforced** on every login. No opt-out on ops. Recovery
    codes generated at enrollment, stored in 1Password.
- **Agents.** API keys issued from `ops.api_keys`:
  - Columns: `id`, `name`, `scopes text[]`, `owner_user_id`,
    `ip_allowlist cidr[]` (optional, deferred), `expires_at`
    (default 90 days from issue), `last_used_at`, `last_used_ip`,
    `revoked_at`, `created_at`, `secret_hash` (Argon2id).
  - Raw secret is shown **once** on creation (modal with copy button
    + warning). Jonathan logs it to 1Password. Never retrievable
    after that.
  - Rotation: `POST /ops/api-keys/:id/rotate` issues a new secret;
    old remains valid for 24h overlap, then expires automatically.
  - Revocation: `DELETE /ops/api-keys/:id` kills the key immediately.

### Request authentication

Every API call carries:

```
Authorization:   Bearer ops_<keyid>_<secret>
X-Ops-Timestamp: <unix seconds>
X-Ops-Signature: hex(HMAC-SHA256(secret, timestamp|method|path|sha256(body)))
X-Ops-Reason:    <short string, required for destructive ops>
```

Server checks:

1. Key exists, not revoked, not expired.
2. Timestamp within ±5 minutes (replay prevention).
3. HMAC matches (integrity + authenticity).
4. Scope covers this method+path.
5. Rate limit has headroom.
6. Destructive op has a non-empty `X-Ops-Reason`.

Bad requests return 401/403 with minimal info. Every failure logs to
`ops.audit_log` along with the IP and user agent.

### Authorization (scopes)

Scopes are additive and granular. Default is zero. Each key lists
exactly what it's allowed to do.

```
read:worklog       write:worklog       admin:worklog
read:roadmap       write:roadmap       admin:roadmap
read:ideas         write:ideas         admin:ideas
read:decisions     write:decisions     admin:decisions
read:knowledge     write:knowledge
admin:maintenance  — reserved for the cron that triggers the weekly run
admin:keys         — reserved for the ops admin UI only (never granted to agents)
```

### Rate limiting

- Phase 0: Supabase-backed. A single `ops.rate_limit_events (key_id, occurred_at)`
  table. Helper `checkRateLimit(keyId, limit, windowSec)` inserts a
  row, deletes rows older than window, counts, allows or 429s. Default
  60 req/min per key.
- Phase 1+: swap the helper body to Vercel KV when agent traffic
  grows. One-file change.

### Audit log

`ops.audit_log`: immutable (RLS allows INSERT only), appends every
mutation and every auth failure. Columns:

```
id uuid, key_id uuid null, admin_user_id uuid null,
method text, path text, status int,
ip inet, user_agent text,
body_sha256 text, reason text null,
occurred_at timestamptz default now()
```

One-year retention (pruned by the maintenance agent).

### Transport + CORS

- TLS 1.3 enforced at the edge.
- `ops.heyhenry.io/api/*` has no CORS headers — server-to-server only.
  Browser calls from `app.heyhenry.io` get blocked. The admin UI on
  `ops.heyhenry.io` reaches its own API on the same origin.
- HSTS with `max-age=31536000; includeSubDomains; preload` on the
  `*.heyhenry.io` apex so a rogue subdomain can't downgrade.

### Anomaly alerts

Slack / email webhook fires when:

- A new IP uses an existing write-scoped key.
- A key is used more than 10× its normal hourly rate.
- A key hits more than 5 auth failures in a minute.
- Any `admin:*` scoped action fires outside business hours.

Phase 1+ — kept out of Phase 0 for scope, but the audit log is the
data source, so it's additive.

### IP allowlist (deferred)

Residential Mac Mini IPs are dynamic, so the `ops.api_keys.ip_allowlist`
column exists but goes unused at launch. Added later via Cloudflare
Tunnel (Mac Mini → CF edge → allowlist CF IP range) once Paperclip
runs in anger.

## Data model (Phase 0)

```sql
-- Humans
CREATE TABLE ops.admins (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  granted_by  uuid REFERENCES auth.users(id)
);

-- Agents
CREATE TABLE ops.api_keys (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  owner_user_id  uuid NOT NULL REFERENCES auth.users(id),
  scopes         text[] NOT NULL DEFAULT '{}',
  ip_allowlist   cidr[] NOT NULL DEFAULT '{}',
  secret_hash    text NOT NULL,
  expires_at     timestamptz NOT NULL,
  last_used_at   timestamptz,
  last_used_ip   inet,
  created_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz
);

CREATE INDEX ops_api_keys_active_idx ON ops.api_keys (id)
  WHERE revoked_at IS NULL AND expires_at > now();

-- Immutable audit trail
CREATE TABLE ops.audit_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id         uuid REFERENCES ops.api_keys(id),
  admin_user_id  uuid REFERENCES auth.users(id),
  method         text NOT NULL,
  path           text NOT NULL,
  status         int NOT NULL,
  ip             inet,
  user_agent     text,
  body_sha256    text,
  reason         text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ops_audit_log_time_idx ON ops.audit_log (occurred_at DESC);
CREATE INDEX ops_audit_log_key_idx  ON ops.audit_log (key_id, occurred_at DESC);

-- Rate limit counter store
CREATE TABLE ops.rate_limit_events (
  key_id       uuid NOT NULL REFERENCES ops.api_keys(id) ON DELETE CASCADE,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ops_rate_limit_key_time_idx
  ON ops.rate_limit_events (key_id, occurred_at DESC);

-- Worklog (Phase 0's first feature)
CREATE TABLE ops.worklog_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type    text NOT NULL CHECK (actor_type IN ('human', 'agent')),
  actor_name    text NOT NULL,
  key_id        uuid REFERENCES ops.api_keys(id),
  admin_user_id uuid REFERENCES auth.users(id),
  category      text,
  site          text,
  title         text,
  body          text,
  tags          text[] NOT NULL DEFAULT '{}',
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ops_worklog_recent_idx ON ops.worklog_entries (created_at DESC)
  WHERE archived_at IS NULL;
```

RLS on every table. `ops.admins` can read + write via the Supabase
session. Service-role key (used by the ops API handler) can read +
write everything after the key check passes. No `authenticated` role
has any access — prevents an ordinary tenant login from reaching ops.

### Later phases (sketched)

```
ops.roadmap_lanes
ops.roadmap_items
ops.roadmap_item_activity
ops.ideas
ops.decisions
ops.decision_outcomes
ops.knowledge_docs
ops.knowledge_embeddings       -- pgvector, Phase 4
ops.references                 -- worklog <-> roadmap cross-links
ops.maintenance_runs
ops.seo_metrics                -- heyhenry.io + marketing site
ops.email_attribution          -- HeyHenry marketing emails via Resend events
ops.revenue_snapshots          -- HeyHenry MRR / churn / trial conversion
ops.ad_spend                   -- if HeyHenry starts running ads
```

Each module is its own incremental commit + migration.

## API surface (Phase 0)

Base URL: `https://ops.heyhenry.io/api/ops`

```
GET   /health                               -- basic liveness + key echo (no secret)
POST  /worklog                              scope: write:worklog
GET   /worklog?since=...&q=...&limit=...    scope: read:worklog
GET   /worklog/:id                          scope: read:worklog
PATCH /worklog/:id                          scope: write:worklog
POST  /worklog/:id/archive                  scope: admin:worklog (requires X-Ops-Reason)
```

All calls require the auth headers above. Every request is audit-logged.

Admin UI routes (human session auth):

```
/                 -- dashboard (recent worklog, key health, rate-limit state)
/worklog          -- timeline, create form
/admin/keys       -- list / create / rotate / revoke
/admin/audit      -- filterable audit log viewer
```

## Admin UI

- Built with the same shadcn stack as the app.
- All routes wrapped in a `<OpsGate />` that checks `ops.admins`
  membership server-side. Non-admins get a 404 (not a 403 — don't
  confirm the URL exists).
- Key creation flow: name + scopes + expiry → POST → show raw secret
  in a one-time modal with a big copy button and a "I've saved this"
  checkbox that dismisses irreversibly.
- Rotation flow: same modal, one-click.
- Revocation: instant, with a confirmation dialog.
- Audit log: filter by key, time range, status, path. Read-only.

## Maintenance agent

Vercel Cron Job (now that we're on Pro) hitting `POST /api/ops/maintenance/run`
weekly (Sundays 6am Pacific). The job uses a dedicated agent key with
`admin:maintenance` scope. Tasks per run (Phase 0 includes tasks 1 and 2
only; the rest land when the referenced modules do):

1. **Archive stale worklog entries.** Older than 60 days, no inbound
   references, not tagged `pinned`. Set `archived_at`.
2. **Write weekly digest.** Summarize the last 7 days into a markdown
   doc inserted as a pinned worklog entry tagged
   `type=weekly_digest`. Uses Gemini 2.5 Flash.
3. **Roadmap dedup flag.** Semantic similarity > 0.85 between any two
   active roadmap items raises a flag. No auto-merge.
4. **Stall detection.** Roadmap items in "In Progress" > 14 days with
   no activity get a stall flag and an auto-worklog note nudging the
   assignee.
5. **Cross-linking.** Scan worklog bodies for roadmap slugs and vice
   versa, populate `ops.references`.
6. **Priority re-rank.** Reference count + recency + assignee
   activity.
7. **Embedding refresh.** Any doc updated since last run gets
   re-embedded.
8. **Audit log prune.** Delete rows older than 1 year.

Each run inserts an `ops.maintenance_runs` row with duration, tasks
run, and counts. Failures alert Slack/email.

## Agent integration contract (Paperclip and friends)

From an agent's perspective:

```ts
const res = await fetch('https://ops.heyhenry.io/api/ops/worklog', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'authorization': `Bearer ${process.env.OPS_KEY}`,
    'x-ops-timestamp': String(Math.floor(Date.now() / 1000)),
    'x-ops-signature': sign(secret, /* ... */),
  },
  body: JSON.stringify({
    actor_name: 'paperclip:content-writer',
    category: 'dev',
    site: 'heyhenry',
    title: 'Drafted Q2 roadmap blurb',
    body: '...',
    tags: ['writing', 'q2'],
  }),
});
```

An npm helper `@heyhenry/ops-client` ships in Phase 1 to wrap the
signing math so agents don't implement it themselves.

## Incremental build order

### Phase 0 — Foundation + worklog MVP (one commit each)

1. **Migration `0049_ops_schema.sql`.** Create `ops` schema, all
   Phase 0 tables, RLS, indexes.
2. **Host-based middleware.** Detect `ops.heyhenry.io` host, gate
   `/app/(app)` routes off and only allow `/app/(ops)` + ops API.
   Ensure `app.heyhenry.io` never serves ops routes and vice versa.
3. **OpsGate + admin auth.** Server helper `getCurrentAdmin()` that
   checks Supabase session + `ops.admins` membership + TOTP MFA
   factor satisfied. 404 on miss.
4. **Key management UI + API.** `/admin/keys` CRUD. One-time secret
   reveal modal. Argon2id hashing. Scopes selection UI.
5. **Request auth helper.** `authenticateOpsRequest(req)` — parses
   headers, loads key, verifies timestamp + HMAC + scope + rate
   limit. Logs to audit_log.
6. **Worklog API endpoints + admin UI.** Create / read / archive.
   End-to-end verify: Jonathan creates a key in UI, curl with HMAC
   posts an entry, entry shows in UI, audit row recorded.

### Phase 1 — Roadmap + ideas + decisions

Adds the three kanban-style modules. Agents can now drive product
and marketing planning.

### Phase 2 — Maintenance agent

Weekly cron running tasks 1 and 2 above. Bumps `maxDuration` on the
maintenance route to 300s.

### Phase 3 — Knowledge vault

`ops.knowledge_docs`, markdown editor, pgvector embeddings, semantic
search. Full feature parity with HenryOS's brain vault for the
HeyHenry scope.

### Phase 4 — Analytics modules

SEO (GSC for heyhenry.io + marketing site), email attribution
(Resend events for HeyHenry's own marketing sends), revenue (MRR /
churn / trial conversion from Stripe), ad spend (if HeyHenry runs
ads). Each module is its own plan doc.

## Open questions + tracked debts

- **Cloudflare Tunnel for IP allowlist.** Deferred, not lost.
  Re-evaluate when Paperclip deploys production agents.
- **Anomaly alert channel.** Slack vs email vs both. Decide before
  Phase 1 ships (it uses the audit log as the source of truth, so
  additive).
- **HenryOS one-way sync.** Optional cron pushing HenryOS worklog
  entries tagged `site=heyhenry` into `ops.worklog_entries`. Not
  scoped for Phase 0.
- **MFA rollout on main app.** Spawned as a separate task.
- **npm package `@heyhenry/ops-client`.** Ships in Phase 1. Until
  then, documented curl recipe in an internal README.
- **Weekly digest LLM choice.** Gemini 2.5 Flash is the default;
  revisit if quality under-delivers.
