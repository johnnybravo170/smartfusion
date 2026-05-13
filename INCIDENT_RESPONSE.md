# Incident Response — HeyHenry

**Status:** v1, 2026-05-13. Owned by Jonathan. Updated after each real
incident or quarterly tabletop, whichever comes first.

This document is the runbook for production incidents on
`app.heyhenry.io`. It exists so that the first paying customer
incident isn't a fire drill where everything is improvised.

If you are in the middle of an incident, jump to **§3 Response
Playbook**.

---

## 1. Severity tiers

| Sev | Definition | Examples | Comms cadence | Target RTO |
|-----|------------|----------|----------------|------------|
| **P1** | Total or near-total outage, customer-visible data loss, or active security breach | App unreachable; Stripe webhooks 100% failing; auth login down; suspected data leak; Supabase project down | Status page + customer email **at declaration, every 30 min, on resolution** | 1 hour |
| **P2** | Major feature broken for most or all tenants | New invoices can't send; photo uploads silently failing; Henry voice errors > 50% | Status page **at declaration + on resolution**; customer email if > 2h | 4 hours |
| **P3** | Significant degradation for some tenants, or major feature broken for one tenant | Dashboard p95 > 10s; one tenant's QBO sync stuck; estimate PDF blank for one customer | In-app banner if useful; direct email to affected tenants | Same business day |
| **P4** | Minor bug, cosmetic, or non-blocking | Wrong icon; misaligned layout; stale cache; non-blocking validation error | Triage to backlog; no public comms | Best effort |

**When in doubt, escalate up.** A P3 reclassified to P2 at hour 1 is
fine; a P2 silently mishandled as P3 for 4 hours is not.

---

## 2. Detection sources

In rough order of likelihood:

1. **Sentry** — `@sentry/nextjs` is wired (PR #233 or thereabouts adds
   tagging). Sentry alerts go to Jonathan via email. Threshold rules
   for P1 (server-side error spike > 10/min) live in the Sentry UI.
2. **Vercel deployment failure** — auto-emailed.
3. **Customer report** — via the in-app helpdesk button, SMS to the
   support number, or direct text/email to Jonathan.
4. **Stripe / Twilio / Postmark dashboard** — webhook delivery
   failures, payment errors, bounce spikes.
5. **Backup-drill failure** — the `nightly-backup.yml` and
   `restore-drill.yml` workflows email `OPS_ALERTS_TO_EMAIL` on
   failure.
6. **Synthetic uptime check** — *not yet wired*. Add UptimeRobot or
   Better Stack against `app.heyhenry.io/api/health` once paying
   customers exist.

---

## 3. Response playbook

When something is on fire:

### 3a. First 5 minutes — assess + declare

1. **Stop poking** at the production app until you've decided this is
   an incident. Refresh isn't fixing it.
2. **Open Sentry, Vercel deployments, Supabase dashboard side-by-side.**
   Is the failure widespread (P1/P2) or scoped to one tenant (P3)?
3. **Declare** by texting yourself the severity + a one-line summary.
   This anchors the timeline; you'll need it for the post-mortem.
4. If P1 or P2, **flip the status page** (see §4) before you start
   investigating. A status page that lags reality by 30 minutes is
   worse than no status page.

### 3b. Next 30 minutes — contain

1. **Did a recent deploy break this?** Check Vercel — was there a deploy
   in the last hour? If yes, **roll back first, debug second.**
   Vercel: project → Deployments → the prior healthy deployment →
   "Promote to Production". Rollback is ~30s.
2. **Is it a third party?** Stripe, Twilio, Postmark, Supabase status
   pages:
   - https://status.stripe.com
   - https://status.twilio.com
   - https://status.postmarkapp.com
   - https://status.supabase.com
   If yes, post on our status page, watch theirs, do nothing rash.
3. **Is data being corrupted?** If a runaway process is writing bad
   data, **stop the process before fixing the data.** Pause the
   relevant cron in `vercel.json` (commit + redeploy), or revoke the
   service-role key in Supabase if necessary.

### 3c. Hours 1-N — fix + communicate

- **Fix forward** for app bugs; **roll back** for infra regressions.
- **Customer comms** at the cadence in §1. Templates in §5.
- **Don't go silent.** Even "still investigating, no new info" every
  30 min on P1 is better than a 90-minute gap.

### 3d. After resolution — post-mortem

- Send the all-clear via the same channel(s) used for declaration.
- Within 48 hours, write a post-mortem (template in §6) and link from
  the worklog. Even for P3s — the goal is institutional memory, not
  blame.

---

## 4. Status page

**Decision needed (deferred):** Statuspage.io ($30+/mo) vs a
self-hosted Vercel sub-route at `status.heyhenry.io` (free).

Until decided, the **interim status page is the in-app banner** —
edit `src/components/layout/header.tsx` to render a red bar when
`process.env.NEXT_PUBLIC_INCIDENT_BANNER` is set, push the env var
via Vercel, ship.

When this graduates, list it here and update §5 templates to point to
the status URL.

---

## 5. Communication templates

### 5a. Customer email — P1 declaration

> Subject: HeyHenry — service disruption in progress
>
> Hi [first name],
>
> We're investigating an issue affecting [brief description: e.g.
> "the ability to send invoices"]. Our team is on it. The next update
> goes out in 30 minutes.
>
> If you need help with something time-sensitive in the meantime,
> reply to this email and we'll respond personally.
>
> — Jonathan, HeyHenry

### 5b. Customer email — resolution

> Subject: HeyHenry — service restored
>
> Hi [first name],
>
> [Brief description of impact] is resolved as of [time]. The cause
> was [one sentence — non-technical].
>
> Total impact window: [start] to [end].
>
> [If any data action is needed by the customer, list here. Otherwise:
> "No action is needed on your end."]
>
> A full post-mortem will follow within 48 hours. Thanks for bearing
> with us — we're treating this with the seriousness it deserves.
>
> — Jonathan, HeyHenry

### 5c. Status-page line — P1

> [TIMESTAMP] **Investigating** — We're seeing elevated errors on
> [feature]. Engineering is engaged. Next update in 30 minutes.

### 5d. Status-page line — P1 resolution

> [TIMESTAMP] **Resolved** — [Feature] is back to normal as of
> [time]. We'll publish a full post-mortem within 48 hours.

---

## 6. Post-mortem template

```
# Post-mortem: <one-line title>

**Severity:** P1 / P2 / P3
**Detected:** [timestamp + source]
**Resolved:** [timestamp]
**Duration:** [Xh Ym]
**Affected:** [tenants / features]

## What happened (timeline)
- HH:MM — [event]
- HH:MM — [event]

## Root cause
1-3 paragraphs. The actual cause, not the proximate trigger. If you
say "deploy X broke it", explain *why* deploy X broke it.

## What went well
3 bullets. Even bad incidents have things that worked.

## What went poorly
3-5 bullets. Where did time leak? What signals did we miss?

## Action items
| # | Action | Owner | Due |
|---|--------|-------|-----|
| 1 | ... | Jonathan | YYYY-MM-DD |

(Each action item gets a kanban card on the dev board.)
```

---

## 7. RACI

Responsible / Accountable / Consulted / Informed for each phase.
With one engineer (Jonathan) on call today, R + A collapse onto him.
This table exists so the moment a second engineer joins, the seams
are pre-cut.

| Phase | R | A | C | I |
|-------|---|---|---|---|
| Detection | Sentry / customer | Jonathan | — | Jonathan |
| Triage + severity call | Jonathan | Jonathan | Henry (LLM context) | — |
| Containment | Jonathan | Jonathan | — | — |
| Customer comms | Jonathan | Jonathan | — | Customers |
| Fix | Jonathan | Jonathan | — | — |
| Post-mortem | Jonathan | Jonathan | Affected customers | All customers (summary) |

---

## 8. Pre-incident checklist (review quarterly)

- [ ] Sentry alert thresholds set + email delivery confirmed (test by
      logging a fake error)
- [ ] Vercel rollback button tested (deploy a no-op, then promote
      previous)
- [ ] Status page mechanism in place (or interim banner mechanism)
- [ ] OPS_ALERTS_TO_EMAIL is the right inbox
- [ ] `pnpm audit --audit-level=critical` is still 0 in CI
- [ ] `nightly-backup.yml` last 3 runs all green
- [ ] `restore-drill.yml` last run green
- [ ] At least one tabletop walkthrough done since last update to
      this document

---

## 9. Tabletop scenarios

Walk these through verbally (or with a buddy) once a quarter. They
exist so you don't first read this document during a real incident.

### 9a. Stripe webhooks 100% failing

You wake up to a Sentry digest: 200+ webhook signature verification
errors overnight. Customers report invoices not marking as paid.

- **Severity?** P1 — revenue path broken.
- **First action?** Check Stripe dashboard webhook deliveries. Was
  it a Stripe rotation of webhook signing secret that we missed?
  Check Vercel env for `STRIPE_WEBHOOK_SECRET`.
- **Containment?** None possible if it's our secret being wrong; just
  fix and redeploy.
- **Status page?** Yes — "Invoice payment confirmation delayed."
- **Post-fix?** Once correct secret is set, the existing webhook
  idempotency table (PR #231) means we can safely re-trigger Stripe's
  retry queue from the Stripe dashboard for any events that bounced.

### 9b. Suspected data breach

You see audit_log entries for `customer.deleted` from an unfamiliar
admin email at 3 AM.

- **Severity?** P1.
- **First action?** Lock the suspect account: rotate their password
  via Supabase Auth admin, kill all their sessions
  (`supabase.auth.admin.signOut(userId)`).
- **Containment?** If you can't tell scope yet, also revoke the
  service-role key and ship a redeploy with the new one. Yes, this
  takes the app down briefly. That's correct.
- **Comms?** Affected tenants get a direct email. Public status page
  goes up if revoking keys took the app down for everyone.
- **Post?** Forensics from `audit_log` (PR #236) tells you exactly
  what was changed. Restore from PITR if data was deleted.

### 9c. Supabase project down

Supabase status page is red, our app shows "internal server error"
on every dynamic route.

- **Severity?** P1.
- **First action?** Confirm via Supabase status. Don't try to fix.
- **Containment?** None possible.
- **Status page?** "Service disruption — upstream provider issue.
  Following Supabase: [their status URL]."
- **Post?** When they recover, our app recovers automatically. Spot-
  check that AR cron, photo uploads, and Stripe webhooks all caught
  up; if any backlog persists, the webhook idempotency table means
  re-delivery is safe.

---

*Last reviewed:* 2026-05-13.
*Next review due:* 2026-08-13.
