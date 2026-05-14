# QA tenant

There is one designated QA / demo tenant on **production**. Use it for any
manual click-through testing — login flows, dashboards, the worker and
bookkeeper layouts, sending estimates/invoices, etc.

## The tenant

**Overflow Test Co** — `7098bd96-9cdd-47af-a412-3679af4cb536`, `pressure_washing` vertical.

| Role | Login | Lands on |
|---|---|---|
| owner | `overflowtest@example.com` | `/dashboard` |
| worker | `overflowtest+worker@example.com` | `/w` |
| bookkeeper | `overflowtest+bookkeeper@example.com` | `/bk` |

Shared password is in the ops knowledge vault (search "QA tenant credentials").
It's not a real secret — the tenant is inert (see below) — but it's kept out
of the repo anyway.

## What `is_demo` does

The tenant has `tenants.is_demo = true`. That flag is load-bearing — see
`src/lib/tenants/demo.ts`:

- **Outbound email + SMS is suppressed.** `sendEmail()` and `sendSms()` still
  write the audit row (`email_send_log` / `twilio_messages`) but with
  `status = 'suppressed_demo'` and never call Postmark / Twilio. Test invoices,
  estimates, and change-order notifications can't reach real inboxes or phones.
  To verify what *would* have sent, read the audit row.
- **Excluded from platform metrics.** `src/lib/db/queries/admin.ts` and
  `src/lib/db/queries/platform-metrics.ts` filter demo tenants out of every
  cross-tenant aggregate (signups, revenue, active tenants, SMS counts, etc.).
  The admin tenant *list* still shows it, badged "QA / demo".

Any new cross-tenant aggregate query MUST exclude demo tenants — use
`getDemoTenantIds()` / `demoExclusionList()` from `src/lib/tenants/demo.ts`,
or filter `is_demo` directly when querying the `tenants` table.

> Not covered: ops-side digests/rollups live in a separate repo and read prod
> directly. They should filter on `tenants.is_demo` too — tracked separately.

## Re-running setup

Both scripts are idempotent:

```
set -a && source .env.local && set +a
node scripts/setup-qa-tenant.mjs              # is_demo flag, password reset, worker+bookkeeper members
pnpm tsx scripts/seed-test-data.ts --email overflowtest@example.com [--reset]
```

`setup-qa-tenant.mjs` configures the tenant + members. `seed-test-data.ts`
fills it with customers / quotes / jobs / invoices (`--reset` wipes data
first, keeps the tenant + members).
