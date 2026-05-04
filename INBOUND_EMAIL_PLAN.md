# Inbound Email Ingestion — Pivot to `henry@heyhenry.io`

**Status:** PLAN — not yet executing
**Date:** 2026-05-04
**Author:** Claude + Jonathan
**Supersedes:** the per-tenant slug architecture shipped Apr 20 (commit `ef47a9c`)

## Problem

GCs receive vendor bills and sub-quote PDFs as email attachments constantly — usually forwarded around inside the company, often to themselves, and just as often lost. We want a single shared inbox at `henry@heyhenry.io` they can forward to from any device. Henry parses the attachment, figures out which project it belongs to, and stages it for one-click confirmation. Nothing reaches its final home (a `project_bills` row, a `project_sub_quotes` row) until the operator clicks confirm.

## What's already built (and what's wrong with it)

Commit `ef47a9c` (Apr 20, 2026) shipped a working Postmark pipeline using **per-tenant slug** addresses (`{tenant.slug}@quotes.heyhenry.io`). Files:

- `supabase/migrations/0047_inbound_emails.sql` — table + RLS
- `src/app/api/inbound/postmark/route.ts` — webhook
- `src/lib/inbound-email/{classifier,processor}.ts` — Gemini classify + auto-apply
- `src/server/actions/inbound-email.ts` — apply / reject / reassign / reclassify
- `src/app/(dashboard)/inbox/email/page.tsx` — review UI
- `src/components/features/inbox/inbound-email-card.tsx` — card UI

Three things are wrong with that design and need to be undone:

1. **Per-tenant slug address.** `henry@heyhenry.io` is the brand. One inbox, sender-based routing.
2. **Auto-apply at ≥0.8 confidence.** Things end up in `project_bills` / `project_cost_lines` without operator review. Operator must always confirm.
3. **Sub-quote forwards explode into N `project_cost_lines` rows.** Loses the "one quote, one row, possibly split across buckets" model. The proper home is `project_sub_quotes` + `project_sub_quote_allocations` (shipped via migration 0095, used today by [src/components/features/projects/sub-quote-upload-button.tsx](src/components/features/projects/sub-quote-upload-button.tsx)). The email pipeline should hand off to that existing flow rather than write its own.

Bills are simpler: `project_bills` is the right home, no allocation editor needed (one bill = one budget category at most). They just lack a dedicated review form today (bills get created opaquely from `intake-augment` and bank reconciliation). For V1 we keep the parsed bill on `inbound_emails.extracted` and write a small `StagedBillConfirmDialog` that mirrors `SubQuoteForm`'s shape.

## Architecture

### Single shared inbox

`henry@heyhenry.io` — one address, all operators. Tenant resolved from the **From** address.

### Sender allowlist

The verified sender is the `auth.users.email` of any `tenant_member` with `role IN ('owner', 'admin')` for that tenant. (Admins on a real tenant can act on the owner's behalf — they can already do everything else operationally; forwarding bills is consistent. Workers cannot forward.) No additional aliases for V1 (per Jonathan's call — confirmed GC emails are enough).

Unknown sender → polite bounce email back. Persist with `status='bounced'` for abuse visibility.

### Three resting depths (the staging cascade)

| Henry's confidence | Lands in | What the operator does |
|---|---|---|
| Sender unknown | (Polite bounce, no row) | Forward from your HeyHenry owner email |
| Sender ✓, project ✗ | **General inbox** (`/inbox/email`) | Pick a project → cascades into project inbox |
| Sender ✓ + project ✓ | **Project inbox** (banner on `/projects/[id]` + visible in general inbox filtered by project) | Click "Confirm" → opens pre-filled review dialog → save commits to `project_bills` / `project_sub_quotes` |

Nothing writes to `project_bills` or `project_sub_quotes` until the operator clicks save in the review dialog. The `inbound_emails` row is the staging layer; `extracted` JSON holds the parsed structure.

### Data flow

```
Postmark → POST /api/inbound/postmark
  ↓
verifyToken                                    (fail → 401)
parsePayload                                   (fail → 400)
resolveTenantFromSender                        (unknown → sendBounce, return 200, no row)
INSERT inbound_emails (status=pending)
  ↓
processInboundEmail (inline, await)
  ↓
classify + extract via gateway('email_classify')
match project against tenant's active projects
UPDATE inbound_emails SET
  classification, confidence, extracted,
  project_id, project_match_confidence,
  status = 'needs_review'                      ('rejected' if classification='other')
  ↓
returns 200 to Postmark

[Operator opens /inbox/email or project banner]
  ↓
Click confirm → open dialog (SubQuoteForm or StagedBillConfirmDialog)
  ↓
Submit → call existing createSubQuoteAction OR insert into project_bills
  ↓
UPDATE inbound_emails SET status='applied', applied_sub_quote_id|applied_bill_id
```

## File map

### Modify
- `src/app/api/inbound/postmark/route.ts` — sender-based resolution, allowlist, bounce
- `src/lib/inbound-email/processor.ts` — strip auto-apply, just stage
- `src/lib/inbound-email/classifier.ts` — no functional change (prompt text touch-up only)
- `src/server/actions/inbound-email.ts` — rework `applyInboundEmailAction` to hand off to existing create paths; new `confirmStagedBillAction` (sub-quote confirm goes through `createSubQuoteAction`)
- `src/app/(dashboard)/inbox/email/page.tsx` — show `henry@heyhenry.io`, optional `?project=` filter
- `src/components/features/inbox/inbound-email-card.tsx` — confirm-and-open-dialog affordance, project picker for unmatched
- `src/app/(dashboard)/projects/[id]/page.tsx` — render staged-emails banner

### Create
- `src/lib/inbound-email/sender-resolver.ts` — FROM address → `{ tenantId, ownerUserId }` lookup
- `src/lib/inbound-email/bounce.ts` — Resend-based polite bounce
- `src/components/features/projects/staged-emails-banner.tsx` — banner with inline list
- `src/components/features/inbox/staged-bill-confirm-dialog.tsx` — bill review/confirm
- `supabase/migrations/0178_inbound_emails_staging.sql` — see Migration

### Verify (read only)
- `supabase/migrations/0095_project_sub_quotes.sql` — confirms columns
- `src/lib/db/schema/project-sub-quotes.ts` — confirms types
- `src/server/actions/sub-quotes.ts` — `createSubQuoteAction` signature
- `src/components/features/projects/sub-quote-form.tsx` — `SubQuoteForm` props (`SubQuoteInitialValues`)
- `src/server/actions/intake-augment.ts` lines 405-455 — bill insert pattern to mirror

## Migration

`supabase/migrations/0178_inbound_emails_staging.sql`:

```sql
-- Add 'bounced' status for unknown-sender records. Keep existing statuses;
-- do not drop 'auto_applied' so historical rows from the pre-pivot era
-- stay readable.
ALTER TABLE public.inbound_emails
  DROP CONSTRAINT inbound_emails_status_check,
  ADD CONSTRAINT inbound_emails_status_check
    CHECK (status IN ('pending', 'processing', 'auto_applied', 'needs_review',
                      'applied', 'rejected', 'error', 'bounced'));

-- Track the sub_quote we created on confirmation. The legacy
-- applied_cost_line_ids array stays for old rows but is no longer written.
ALTER TABLE public.inbound_emails
  ADD COLUMN IF NOT EXISTS applied_sub_quote_id UUID
    REFERENCES public.project_sub_quotes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inbound_emails_applied_sub_quote
  ON public.inbound_emails(applied_sub_quote_id)
  WHERE applied_sub_quote_id IS NOT NULL;

-- Sender→tenant lookup. SECURITY DEFINER so we can join auth.users from
-- the app layer without exposing the auth schema. Returns the matched
-- tenant_id, or NULL if no match / ambiguous (multi-tenant ownership).
CREATE OR REPLACE FUNCTION public.resolve_inbound_sender(p_email text)
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_count int;
  v_tenant_id uuid;
BEGIN
  SELECT count(*), max(tm.tenant_id)
  INTO v_count, v_tenant_id
  FROM public.tenant_members tm
  JOIN auth.users u ON u.id = tm.user_id
  WHERE lower(u.email) = lower(trim(p_email))
    AND tm.role IN ('owner', 'admin');

  IF v_count = 1 THEN
    RETURN v_tenant_id;
  END IF;
  RETURN NULL;  -- 0 = unknown, >1 = ambiguous (treat both as bounce)
END
$$;

REVOKE ALL ON FUNCTION public.resolve_inbound_sender(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_inbound_sender(text) TO service_role;
```

Per [feedback_apply_migrations.md](memory) — apply via `supabase db query --linked -f` and insert the bare-version row, not `db:push`.

## Decisions locked (2026-05-04)

- **DNS:** GoDaddy forward — `henry@heyhenry.io` → Postmark inbound. heyhenry.io MX stays where it is.
- **Banner UX:** preview last 3 staged items inline + "See all" link to `/inbox/email?project={id}`.
- **Resend outbound `henry@heyhenry.io`:** NOT yet registered. A0 must add it (only `noreply@heyhenry.io` is registered today). Bounce sender (A3) cannot ship until this is done.
- **Bounce persistence:** persist with `status='bounced'` for abuse visibility.

## Out of scope (explicit)

- Verified forwarding aliases (`tenant_members.additional_forwarding_emails`). Owner email only.
- Magic-link confirmation in a reply email. In-app only.
- Henry sending an outbound reply ("Got it — applied $X"). Maybe later.
- Bypass-on-explicit-instruction ("apply to master bath on Smith"). Pre-fills project + allocation when present, but the click stays.
- Exploding a sub-quote into per-line `project_cost_lines`. One quote = one row in `project_sub_quotes`. Splitting across buckets is opt-in via the existing `AllocationEditor`.
- Worker forwarding. Owners only.

---

## Tasks

Each task is small enough to commit on its own. Per [feedback_commit_and_push.md](memory) and [feedback_always_push_live.md](memory), commit AND push after each greenlit task — Jonathan only verifies live.

### Phase A — Infrastructure pivot (server side)

#### A0. DNS + Postmark + Resend setup (Jonathan-driven)

**Files:** none (manual / dashboard work)

This is the only task that requires Jonathan's hands on the GoDaddy / Postmark / Resend dashboards. Code work in A1-A6 / B1-B4 can proceed in parallel — they don't depend on the live mail flow until the C1 smoke test.

- [ ] **GoDaddy:** add an email forward for `henry@heyhenry.io` → the Postmark inbound address (Postmark provides this when you create the Inbound Server below). MX records stay as-is.
- [ ] **Postmark:** create an Inbound Server (or reuse if one exists). Copy the inbound forward address. Set the webhook URL to `https://app.heyhenry.io/api/inbound/postmark?token=<POSTMARK_INBOUND_TOKEN>` (env var already in Vercel).
- [ ] **Resend:** add `henry@heyhenry.io` as a verified sender on the heyhenry.io domain (only `noreply@heyhenry.io` is registered today). The bounce sender in A3 sends from this address — it will fail without this step.
- [ ] Send a test forward from `jonathan@heyhenry.io` to `henry@heyhenry.io`. Check Postmark's inbound activity log shows it parsed.

**Verify:** Postmark inbound activity log shows the test message. HTTP webhook attempt visible (401 expected at this stage — the route still uses old per-tenant-slug logic).

#### A1. Migration

**Files:**
- create `supabase/migrations/0178_inbound_emails_staging.sql` (content above)

**Steps:**
- [ ] Write the migration file
- [ ] Apply via `supabase db query --linked -f supabase/migrations/0178_inbound_emails_staging.sql`
- [ ] Insert history row matching the pattern from [project_heyhenry_migrations.md](memory)
- [ ] Verify in Supabase dashboard: status check constraint includes `'bounced'`, `applied_sub_quote_id` column exists with FK and partial index
- [ ] Regenerate Drizzle types if there's a Drizzle schema for `inbound_emails` (check `src/lib/db/schema/` — there isn't one currently per `grep`, so skip)
- [ ] Commit + push

**Verify:** `select column_name, data_type from information_schema.columns where table_name='inbound_emails' and column_name='applied_sub_quote_id'` returns a row.

#### A2. Sender resolver

**Files:**
- create `src/lib/inbound-email/sender-resolver.ts`
- create `src/lib/inbound-email/sender-resolver.test.ts`

**Behaviour:**
Thin wrapper over the `resolve_inbound_sender(text)` RPC defined in A1. The RPC does the `auth.users` JOIN (which the app layer can't do directly because the Supabase admin email-lookup APIs are list-only / paginated — see `tests/e2e/*.spec.ts` for the existing `admin.auth.admin.listUsers()` pattern, which is wrong for runtime lookups).

**Code:**

```ts
// src/lib/inbound-email/sender-resolver.ts

import { createAdminClient } from '@/lib/supabase/admin';

/** Strip "Display Name <addr@domain>" → "addr@domain" lowercase. */
export function normaliseEmail(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

/**
 * Resolve a forwarder's From address to the tenant they own/admin.
 *
 * V1 rules (enforced inside the RPC):
 * - Case-insensitive match against auth.users.email
 * - Tenant member must have role IN ('owner', 'admin')
 * - Single-tenant membership only — multi-tenant owners (platform admins
 *   on test tenants) return null and get bounced
 */
export async function resolveSenderToTenant(
  fromHeader: string,
): Promise<string | null> {
  const email = normaliseEmail(fromHeader);
  if (!email.includes('@')) return null;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc('resolve_inbound_sender', { p_email: email });
  if (error) {
    console.error('[sender-resolver] RPC failed', error);
    return null;
  }
  return (data as string | null) ?? null;
}
```

(Returning just `tenantId` is enough — we don't need `ownerUserId` downstream. If a future task needs it, add it to the RPC's return shape then.)

**Tests** — match existing test pattern (likely Vitest in `tests/unit/`):

```ts
// src/lib/inbound-email/sender-resolver.test.ts

import { describe, expect, it } from 'vitest';
import { normaliseEmail } from './sender-resolver';

describe('normaliseEmail', () => {
  it('strips display name', () => {
    expect(normaliseEmail('Jonathan B <jonathan@heyhenry.io>')).toBe('jonathan@heyhenry.io');
  });
  it('lowercases', () => {
    expect(normaliseEmail('Jonathan@HeyHenry.IO')).toBe('jonathan@heyhenry.io');
  });
  it('trims whitespace', () => {
    expect(normaliseEmail('  jvd@example.com  ')).toBe('jvd@example.com');
  });
});
```

(Live DB-touching tests for `resolveSenderToTenant` go in an integration suite if one exists — otherwise verified by manual smoke in A4.)

**Steps:**
- [ ] Verify whether `users_view` or equivalent exists; pick the right Supabase admin lookup
- [ ] Write `sender-resolver.ts`
- [ ] Write unit tests for `normaliseEmail`
- [ ] Run tests: `pnpm vitest run src/lib/inbound-email/sender-resolver.test.ts`
- [ ] Commit + push

**Verify:** Tests pass.

#### A3. Bounce sender

**Files:**
- create `src/lib/inbound-email/bounce.ts`

**Behaviour:**
Given an unknown From address, send a polite reply via Resend (already wired in the app). Subject: "Re: <original subject>". Body: short explanation + the operator's recovery path.

**Code:**

```ts
// src/lib/inbound-email/bounce.ts

import { Resend } from 'resend';

const FROM = 'Henry <henry@heyhenry.io>';

export async function sendUnknownSenderBounce(args: {
  to: string;
  originalSubject: string;
}): Promise<void> {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.warn('[bounce] RESEND_API_KEY missing — skipping bounce send');
    return;
  }
  const resend = new Resend(resendKey);

  const subject = args.originalSubject.startsWith('Re:')
    ? args.originalSubject
    : `Re: ${args.originalSubject}`;

  const text = [
    `Hi,`,
    ``,
    `I didn't recognise this sender address, so I haven't filed your forward.`,
    ``,
    `Forward from the email address you signed up to HeyHenry with — that's the only`,
    `address I currently accept attachments from. (If you want a second address`,
    `allowlisted, that's coming soon. Reply support@heyhenry.io and we'll sort it.)`,
    ``,
    `— Henry`,
  ].join('\n');

  await resend.emails.send({
    from: FROM,
    to: args.to,
    subject,
    text,
  });
}
```

**Steps:**
- [ ] Confirm the app already imports `resend` somewhere (it does — used by autoresponder per [project_heyhenry_resend_upgrade.md](memory)). Match that import style.
- [ ] Verify `henry@heyhenry.io` is verified for outbound sending in Resend. If not, add to A0.
- [ ] Write the file
- [ ] Commit + push

**Verify:** Manual — call from a one-off script or test endpoint with your own email; receipt of the bounce.

#### A4. Webhook rewrite

**Files:**
- modify `src/app/api/inbound/postmark/route.ts`

**Diff (conceptual):**
Replace `extractSlug` + tenant lookup by To-address with `resolveSenderToTenant(payload.From)`. If unresolved → call `sendUnknownSenderBounce`, optionally persist with `status='bounced'` per D2, return 200 (don't make Postmark retry).

**Code:**

```ts
// src/app/api/inbound/postmark/route.ts

import { NextResponse } from 'next/server';
import { sendUnknownSenderBounce } from '@/lib/inbound-email/bounce';
import { processInboundEmail } from '@/lib/inbound-email/processor';
import { resolveSenderToTenant } from '@/lib/inbound-email/sender-resolver';
import { createAdminClient } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const maxDuration = 60;

type PostmarkAttachment = {
  Name: string;
  ContentType: string;
  Content: string;
  ContentLength: number;
};

type PostmarkInbound = {
  MessageID: string;
  From: string;            // "Display Name <addr@domain>"
  FromName?: string;
  To: string;
  OriginalRecipient?: string;
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  Attachments?: PostmarkAttachment[];
};

function verifyToken(url: string): boolean {
  const expected = process.env.POSTMARK_INBOUND_TOKEN;
  if (!expected) return false;
  return new URL(url).searchParams.get('token') === expected;
}

export async function POST(request: Request) {
  if (!verifyToken(request.url)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: PostmarkInbound;
  try {
    payload = (await request.json()) as PostmarkInbound;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const tenantId = await resolveSenderToTenant(payload.From);
  const admin = createAdminClient();

  // Unknown sender — bounce, persist a row for visibility, return 200.
  if (!tenantId) {
    try {
      await sendUnknownSenderBounce({
        to: payload.From,
        originalSubject: payload.Subject ?? '(no subject)',
      });
    } catch (err) {
      console.error('[inbound-email] bounce send failed', err);
    }
    await admin.from('inbound_emails').insert({
      tenant_id: null,
      postmark_message_id: payload.MessageID,
      to_address: payload.OriginalRecipient || payload.To,
      from_address: payload.From,
      from_name: payload.FromName ?? null,
      subject: payload.Subject ?? null,
      body_text: payload.TextBody ?? null,
      body_html: payload.HtmlBody ?? null,
      attachments: (payload.Attachments ?? []).map((a) => ({
        filename: a.Name,
        contentType: a.ContentType,
        size: a.ContentLength,
        // Don't persist base64 for bounced rows — keep table small.
      })),
      raw_payload: null,
      status: 'bounced',
      error_message: 'Sender not allowlisted (must be a tenant owner email)',
    });
    return NextResponse.json({ ok: true, bounced: true });
  }

  const attachments = (payload.Attachments ?? []).map((a) => ({
    filename: a.Name,
    contentType: a.ContentType,
    base64: a.Content,
    size: a.ContentLength,
  }));

  const { data: inserted, error } = await admin
    .from('inbound_emails')
    .insert({
      tenant_id: tenantId,
      postmark_message_id: payload.MessageID,
      to_address: payload.OriginalRecipient || payload.To,
      from_address: payload.From,
      from_name: payload.FromName ?? null,
      subject: payload.Subject ?? null,
      body_text: payload.TextBody ?? null,
      body_html: payload.HtmlBody ?? null,
      attachments,
      raw_payload: payload as unknown as Record<string, unknown>,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error || !inserted) {
    console.error('[inbound-email] persist failed', error);
    return NextResponse.json({ error: error?.message ?? 'Insert failed' }, { status: 500 });
  }

  try {
    await processInboundEmail(inserted.id as string);
  } catch (err) {
    console.error('[inbound-email] processing failed', inserted.id, err);
  }

  return NextResponse.json({ ok: true, id: inserted.id });
}
```

**Steps:**
- [ ] Replace the file
- [ ] `pnpm lint && pnpm typecheck`
- [ ] Commit + push
- [ ] Send a test forward from `jonathan@heyhenry.io` to `henry@heyhenry.io`
- [ ] Verify in Supabase dashboard: row in `inbound_emails` with `tenant_id` set, `status='pending'` then `'needs_review'` after processor runs (still old processor)

**Verify:** A real Postmark forward results in an `inbound_emails` row tied to the right tenant. An unknown-sender forward does NOT result in a row (or results in a `status='bounced'` row) and the sender receives a bounce email.

#### A5. Processor rewrite (strip auto-apply)

**Files:**
- modify `src/lib/inbound-email/processor.ts`

**What changes:** Delete the entire auto-apply branch. After classification + project match, just update the row to `status='needs_review'` (or `'rejected'` for `classification='other'`).

**Code:**

```ts
// src/lib/inbound-email/processor.ts

import { createAdminClient } from '@/lib/supabase/admin';
import { type ClassifierResult, classifyInboundEmail, type ProjectContext } from './classifier';

export async function processInboundEmail(emailId: string): Promise<void> {
  const admin = createAdminClient();

  const { data: email, error: loadErr } = await admin
    .from('inbound_emails')
    .select('*')
    .eq('id', emailId)
    .single();

  if (loadErr || !email) throw new Error(`Inbound email not found: ${emailId}`);
  if (!email.tenant_id) {
    await admin
      .from('inbound_emails')
      .update({
        status: 'error',
        error_message: 'No tenant resolved from sender',
        processed_at: new Date().toISOString(),
      })
      .eq('id', emailId);
    return;
  }

  await admin.from('inbound_emails').update({ status: 'processing' }).eq('id', emailId);

  const { data: projectsRaw } = await admin
    .from('projects')
    .select('id, name, description, customers:customer_id (name)')
    .eq('tenant_id', email.tenant_id)
    .is('deleted_at', null)
    .in('lifecycle_stage', ['planning', 'awaiting_approval', 'active']);

  const projects: ProjectContext[] = (projectsRaw ?? []).map((p) => {
    const customerRaw = Array.isArray(p.customers) ? p.customers[0] : p.customers;
    return {
      id: p.id as string,
      name: p.name as string,
      description: (p.description as string | null) ?? null,
      customer_name:
        customerRaw && typeof customerRaw === 'object' && 'name' in customerRaw
          ? (customerRaw as { name: string }).name
          : null,
    };
  });

  const attachments = (
    (email.attachments as { filename: string; contentType: string; base64: string }[]) ?? []
  ).slice(0, 5);

  let result: ClassifierResult;
  try {
    result = await classifyInboundEmail(
      {
        from: email.from_address as string,
        from_name: (email.from_name as string | null) ?? null,
        subject: (email.subject as string | null) ?? '',
        body_text: (email.body_text as string | null) ?? '',
        attachments,
      },
      projects,
      email.tenant_id as string,
    );
  } catch (err) {
    await admin
      .from('inbound_emails')
      .update({
        status: 'error',
        error_message: err instanceof Error ? err.message : String(err),
        processed_at: new Date().toISOString(),
      })
      .eq('id', emailId);
    return;
  }

  // No auto-apply path. Stage everything; operator confirms.
  const status = result.classification === 'other' ? 'rejected' : 'needs_review';

  await admin
    .from('inbound_emails')
    .update({
      classification: result.classification,
      confidence: result.confidence,
      extracted: result.extracted,
      classifier_notes: result.notes,
      project_id: result.project_match?.id ?? null,
      project_match_confidence: result.project_match?.confidence ?? null,
      status,
      processed_at: new Date().toISOString(),
    })
    .eq('id', emailId);
}
```

**Steps:**
- [ ] Replace the file
- [ ] `pnpm lint && pnpm typecheck`
- [ ] Commit + push
- [ ] Re-send a test forward — verify the row lands in `status='needs_review'` (not `'auto_applied'`) regardless of confidence

**Verify:** Forward a quote PDF with high-confidence project match. Row goes to `needs_review`, NOT `auto_applied`. No row created in `project_bills` or `project_sub_quotes`.

#### A6. Confirm actions — bills

**Files:**
- modify `src/server/actions/inbound-email.ts`

**What changes:**
- Replace the existing `applyInboundEmailAction`'s sub_quote branch with an error: "Use `confirmStagedSubQuoteAction` (UI hand-off to SubQuoteForm)" — actually no, simpler: keep `applyInboundEmailAction` for bills only, and let the sub-quote path go through the SubQuoteForm flow which calls `createSubQuoteAction` directly.
- Net: `applyInboundEmailAction` becomes "confirm a staged bill with these (possibly edited) fields → write to project_bills". Caller passes the edited fields back; we don't trust the staged `extracted` JSON because the operator may have edited it.
- Add `linkInboundEmailToSubQuoteAction({ emailId, subQuoteId })` — called by `SubQuoteForm` after successful save when initiated from an email. Updates `inbound_emails.status='applied'`, `applied_sub_quote_id=…`.
- Keep `rejectInboundEmailAction` and `reclassifyInboundEmailAction` as-is.
- Remove `reassignInboundEmailAction` — it moved already-applied data between projects, no longer relevant since we don't auto-apply.

**Code (new `applyInboundEmailAction` — bill confirmation):**

```ts
'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type InboundEmailResult = { ok: true; id: string } | { ok: false; error: string };

const billConfirmSchema = z.object({
  emailId: z.string().uuid(),
  projectId: z.string().uuid(),
  vendor: z.string().trim().min(1),
  vendorGstNumber: z.string().trim().optional(),
  billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountCents: z.coerce.number().int().min(0),
  gstCents: z.coerce.number().int().min(0).default(0),
  description: z.string().trim().optional(),
  budgetCategoryId: z.string().uuid().optional(),
  costLineId: z.string().uuid().optional(),
});

export async function confirmStagedBillAction(
  input: z.input<typeof billConfirmSchema>,
): Promise<InboundEmailResult> {
  const parsed = billConfirmSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  const data = parsed.data;

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  const { data: email, error: loadErr } = await supabase
    .from('inbound_emails')
    .select('id, tenant_id')
    .eq('id', data.emailId)
    .single();
  if (loadErr || !email) return { ok: false, error: 'Inbound email not found.' };

  const { data: bill, error: billErr } = await supabase
    .from('project_bills')
    .insert({
      tenant_id: tenant.id,
      project_id: data.projectId,
      vendor: data.vendor,
      vendor_gst_number: data.vendorGstNumber || null,
      bill_date: data.billDate,
      description: data.description || null,
      amount_cents: data.amountCents,
      gst_cents: data.gstCents,
      budget_category_id: data.budgetCategoryId || null,
      cost_line_id: data.costLineId || null,
      status: 'pending',
    })
    .select('id')
    .single();

  if (billErr || !bill) return { ok: false, error: billErr?.message ?? 'Failed to create bill.' };

  await supabase
    .from('inbound_emails')
    .update({
      project_id: data.projectId,
      status: 'applied',
      applied_bill_id: bill.id,
      processed_at: new Date().toISOString(),
    })
    .eq('id', data.emailId);

  revalidatePath('/inbox/email');
  revalidatePath(`/projects/${data.projectId}`);
  return { ok: true, id: bill.id as string };
}

export async function linkInboundEmailToSubQuoteAction(input: {
  emailId: string;
  subQuoteId: string;
  projectId: string;
}): Promise<InboundEmailResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('inbound_emails')
    .update({
      project_id: input.projectId,
      status: 'applied',
      applied_sub_quote_id: input.subQuoteId,
      processed_at: new Date().toISOString(),
    })
    .eq('id', input.emailId);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/inbox/email');
  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, id: input.emailId };
}

export async function rejectInboundEmailAction(emailId: string): Promise<InboundEmailResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('inbound_emails')
    .update({ status: 'rejected', processed_at: new Date().toISOString() })
    .eq('id', emailId);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/inbox/email');
  return { ok: true, id: emailId };
}

export async function reclassifyInboundEmailAction(emailId: string): Promise<InboundEmailResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('inbound_emails')
    .update({
      status: 'pending',
      classification: 'unclassified',
      confidence: null,
      extracted: null,
      classifier_notes: null,
      project_id: null,
      project_match_confidence: null,
      error_message: null,
    })
    .eq('id', emailId);
  if (error) return { ok: false, error: error.message };

  const { processInboundEmail } = await import('@/lib/inbound-email/processor');
  await processInboundEmail(emailId);

  revalidatePath('/inbox/email');
  return { ok: true, id: emailId };
}
```

**Steps:**
- [ ] Rewrite the file with the new actions + remove `reassignInboundEmailAction`
- [ ] Search callers: `grep -rn "reassignInboundEmailAction\|applyInboundEmailAction" src/` — note all UI files using these (will be updated in A6b)
- [ ] **Don't typecheck yet** — UI callers will break. Commit + push together with A6b as a single feature-complete state.

**Verify:** N/A this task in isolation; verified end-to-end after A6b.

#### A6b. Update UI callers to compile

**Files:**
- modify any caller of `applyInboundEmailAction` or `reassignInboundEmailAction` flagged in A6a (likely just `src/components/features/inbox/inbound-email-card.tsx`)

**Steps:**
- [ ] For each caller: replace `applyInboundEmailAction({ emailId, projectId })` with a placeholder that opens the upcoming confirm dialog (B2/B3). For now, a `toast('Confirm flow coming in next deploy')` stub is fine — real wiring lands in B3.
- [ ] Remove all references to `reassignInboundEmailAction`
- [ ] `pnpm lint && pnpm typecheck` — must pass
- [ ] Commit + push

**Verify:** App typechecks. `/inbox/email` loads, the old "Apply" button is replaced with the stub.

### Phase B — UI surfaces

#### B1. Inbox page — show new address, optional project filter

**Files:**
- modify `src/app/(dashboard)/inbox/email/page.tsx`

**Changes:**
- Replace `const inboundAddress = \`${tenant.slug}@quotes.heyhenry.io\`` with `const inboundAddress = 'henry@heyhenry.io'`.
- Add optional `?project=<id>` filter (used by the project banner "see all" link).
- Filter tabs unchanged.
- Page header copy: "Forward bills and sub-quotes to `henry@heyhenry.io` from your account email — Henry parses and stages them for your confirmation."

**Steps:**
- [ ] Edit the file
- [ ] Eyeball at `/inbox/email` (after deploy)
- [ ] Commit + push

**Verify:** Address shown is `henry@heyhenry.io`. `?project=<id>` filter works.

#### B2. Bill confirm dialog

**Files:**
- create `src/components/features/inbox/staged-bill-confirm-dialog.tsx`

**Behaviour:**
- Props: `email: InboundEmailRow`, `projects: { id, name }[]`, `categories?: { id, name }[]` (loaded for picked project)
- Form fields: project (dropdown, pre-filled from `email.project_id`), vendor, GST#, bill_date, amount_cents, gst_cents, description, budget_category (dropdown), cost_line (optional dropdown).
- Pre-fill from `email.extracted` (parsed bill JSON).
- Submit calls `confirmStagedBillAction`. Toast result, close dialog, revalidate.

Match the shape of [src/components/features/projects/sub-quote-form.tsx](src/components/features/projects/sub-quote-form.tsx) for consistency.

Field validation client-side (zod schema mirrored in client) before submit.

**Steps:**
- [ ] Write the component
- [ ] Wire `InboundEmailCard` to open it for `classification='vendor_bill'` + `status='needs_review'`
- [ ] `pnpm lint && pnpm typecheck`
- [ ] Manual smoke: forward a real vendor PDF, confirm via dialog, check `project_bills` has the row
- [ ] Commit + push

**Verify:** Forwarded vendor bill ends up in `project_bills` after operator confirms. No row in `project_bills` before they confirm.

#### B3. Sub-quote confirm path — wire inbox card to existing SubQuoteForm

**Files:**
- modify `src/components/features/inbox/inbound-email-card.tsx`
- modify `src/components/features/projects/sub-quote-form.tsx` — two changes:
  1. Add optional prop `linkToInboundEmail?: { emailId: string }`
  2. Modify the submit handler at lines 274-281: after `result.ok` succeeds, if `linkToInboundEmail` is set, call `linkInboundEmailToSubQuoteAction({ emailId, subQuoteId: result.id, projectId })` BEFORE `onDone()`. The `result.id` is already returned by `createSubQuoteAction` (see [src/server/actions/sub-quotes.ts:190](src/server/actions/sub-quotes.ts:190)) but currently discarded — capture it.

**Behaviour:**
For `classification='sub_quote'` + `status='needs_review'`:
- Card shows "Henry parsed this as a sub-quote from [vendor] for [project name]. [Review and confirm]"
- Click → opens existing `<SubQuoteForm>` in a dialog (re-use the dialog wrapper from `sub-quote-upload-button.tsx`), pre-filled from `email.extracted`
- Pass `linkToInboundEmail={{ emailId: email.id }}`. SubQuoteForm handles the link-back internally.

For project unmatched: card has a project picker; selecting a project loads its `categories` and opens the dialog.

**Diff sketch for `sub-quote-form.tsx` submit:**

```ts
// Capture id (was discarded)
const result = await createSubQuoteAction(fd);
if (!result.ok) {
  setError(result.error);
  toast.error(result.error);
  return;
}
toast.success('Vendor quote saved.');

// Link inbound email if this form was opened from one
if (linkToInboundEmail) {
  const { linkInboundEmailToSubQuoteAction } = await import(
    '@/server/actions/inbound-email'
  );
  await linkInboundEmailToSubQuoteAction({
    emailId: linkToInboundEmail.emailId,
    subQuoteId: result.id,
    projectId,
  });
}

onDone();
```

**Steps:**
- [ ] Update `inbound-email-card.tsx` — branch on classification, render the right dialog opener
- [ ] Add `onSavedFromInboundEmail` plumbing in `sub-quote-form.tsx`
- [ ] `pnpm lint && pnpm typecheck`
- [ ] Smoke: forward a sub-quote PDF, click confirm, edit allocations, save, verify `project_sub_quotes` + allocations rows + `inbound_emails.applied_sub_quote_id` set
- [ ] Commit + push

**Verify:** Forwarded sub-quote → operator clicks Confirm → existing SubQuoteForm opens pre-filled → operator saves → `project_sub_quotes` row created + `inbound_emails` linked.

#### B4. Project page banner

**Files:**
- create `src/components/features/projects/staged-emails-banner.tsx`
- modify `src/app/(dashboard)/projects/[id]/page.tsx` — query staged items count + render banner

**Behaviour:**
- Query: `inbound_emails` where `project_id=$1 AND status='needs_review'`. Limit 3 for the inline preview, total count for the banner.
- Render: dismissable banner ("[N] forwarded items waiting on you. [Review →]"), inline preview of last 3 with the same Confirm action as the inbox card. "See all" link → `/inbox/email?project={id}`.
- Banner state: dismissable per session via `localStorage` (keyed by project id) — re-shows next session if items still pending.

**Steps:**
- [ ] Write the banner component
- [ ] Add the query + render in the project page
- [ ] `pnpm lint && pnpm typecheck`
- [ ] Smoke: forward two items for one project, see banner appear; confirm one, banner shows 1; dismiss; reload, banner hidden; new forward, banner returns
- [ ] Commit + push
- [ ] Update `PATTERNS.md` if banner becomes a reusable pattern

**Verify:** Banner appears when staged items exist for a project, dismisses cleanly, "see all" links to filtered inbox.

### Phase C — Verification + cleanup

#### C1. End-to-end manual test

- [ ] From `jonathan@heyhenry.io` (a tenant owner): forward a real vendor bill PDF to `henry@heyhenry.io`. Verify it appears in `/inbox/email` with `needs_review`, project matched.
- [ ] Click Confirm on the bill, edit a field, save. Verify `project_bills` row, banner cleared, status='applied'.
- [ ] From `jonathan@heyhenry.io`: forward a sub-quote PDF. Confirm via SubQuoteForm. Verify `project_sub_quotes` + allocations.
- [ ] From a non-owner email (e.g. a personal Gmail): forward something. Verify bounce email arrives, row in `inbound_emails` with `status='bounced'` and no tenant_id, NO row in any final table.
- [ ] Forward something with a deliberately ambiguous project reference. Verify it lands with `project_id=null` and shows in the general `/inbox/email` view, NOT in any project banner.

#### C2. Drop dead code

The previous Apr 20 implementation has these dead callers/columns:

- `applied_cost_line_ids` column — leave it (historical data)
- `'auto_applied'` status enum value — leave it (historical data)
- `extractSlug` function in the route — deleted in A4
- `reassignInboundEmailAction` — deleted in A6
- The `quotes.heyhenry.io` MX records (if any) — keep until 30 days post-launch in case any operator's mail client has the old address cached, then remove

Spawn a separate cleanup task at 30 days for column/enum cleanup if we ever back to it (per CLAUDE.md feature-mode rules — don't bundle into this work).

#### C3. Update the SUB_QUOTES_PLAN.md

- [ ] In `SUB_QUOTES_PLAN.md` Phase 3 section: replace "Full spec lands when Phase 2 is shipped and we pick up this phase" with a pointer to `INBOUND_EMAIL_PLAN.md`.

---

## Test plan

- **Unit:** `normaliseEmail` (A2)
- **Integration / smoke:** A4 webhook with real Postmark test forward; A5 processor staging behaviour; B2/B3 dialogs end-to-end (C1)
- **Manual on live:** every phase boundary (per [feedback_always_push_live.md](memory))

## Risks

- **DNS misconfiguration** sends mail to a black hole. Mitigation: send a test forward right after A0 and check Postmark's inbound dashboard before continuing.
- **Sender resolver lookup performance.** The RPC joins `auth.users` on `lower(email)`. `auth.users.email` is already indexed by Supabase (case-insensitive); the JOIN to `tenant_members` is on a uuid PK. No app-side index work needed. Re-check with `EXPLAIN ANALYZE` if forwards exceed ~1/sec.
- **Postmark base64 attachments inflate the row size** — `inbound_emails.attachments` is JSONB. At 10MB attachments × N forwards/day, this grows. Acceptable for V1; switch to storage upload + signed URL later if it gets noisy.
- **Multi-owner platform admins** (Jonathan on test tenants) get bounced. Acceptable for V1, document in admin notes.
