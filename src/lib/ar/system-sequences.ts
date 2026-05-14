/**
 * System AR sequences — installed per-tenant on first need, idempotent.
 *
 * These are platform-defined sequence templates that ship with HeyHenry.
 * Each tenant gets their own copy (so they can edit subject lines, body
 * text, cadence) but the original install is uniform across tenants.
 *
 * The installer is identified by a stable key on the sequence row
 * (`trigger_config.system_key = 'quote_followup_v1'`) so we can find it
 * later for enrollment without needing a separate registry table.
 *
 * Cadence (v1):
 *   T+24h SMS: short, friendly check-in
 *   T+48h email: longer, attaches the quote again
 *   T+72h: deferred — see follow-up card. Currently no third step.
 *
 * CASL: messages carry `caslCategory: 'response_to_request'` because the
 * recipient asked for the quote. The unsubscribe link in the email body
 * + the `do_not_auto_message` customer flag together honor any stop signal.
 */

import { and, eq, sql } from 'drizzle-orm';
import { hasFeature } from '@/lib/billing/features';
import { getDb } from '@/lib/db/client';
import { arSequences, arSteps, arTemplates } from '@/lib/db/schema/ar';
import { createAdminClient } from '@/lib/supabase/admin';

export const QUOTE_FOLLOWUP_SYSTEM_KEY = 'quote_followup_v1' as const;

/**
 * Tag applied to a contact at T+72h when the customer hasn't responded.
 * Surface this in the dashboard "Money at Risk" card so the owner sees
 * which leads need a personal touch.
 */
export const NEEDS_OWNER_ATTENTION_TAG = 'needs_owner_attention' as const;

const SMS_BODY = `Hi {{first_name}}, just checking — did you get a chance to look at the quote we sent? Happy to walk through it or tweak anything. Reply STOP to opt out.`;

const EMAIL_SUBJECT = 'Following up on your quote';
const EMAIL_BODY_HTML = `<!doctype html>
<html><body style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #111;">
  <p>Hi {{first_name}},</p>
  <p>Wanted to make sure my email made it to you a couple of days ago — quote attached again below. Happy to walk through it, tweak the scope, or answer any questions whenever you've got a minute.</p>
  <p>Just hit reply if anything's on your mind.</p>
  <p>Thanks,<br>{{from_name}}</p>
</body></html>`;
const EMAIL_BODY_TEXT = `Hi {{first_name}},

Wanted to make sure my email made it to you a couple of days ago — quote attached again. Happy to walk through it, tweak the scope, or answer any questions.

Just hit reply if anything's on your mind.

Thanks,
{{from_name}}`;

/**
 * Ensure the quote-followup sequence exists for a tenant. Creates it (with
 * its templates and steps) if missing; otherwise no-op. Returns the
 * sequence id.
 */
export async function ensureQuoteFollowupSequence(tenantId: string): Promise<string> {
  const db = getDb();

  // Look for an existing system sequence by key.
  const existing = await db
    .select({ id: arSequences.id, triggerConfig: arSequences.triggerConfig })
    .from(arSequences)
    .where(
      and(
        eq(arSequences.tenantId, tenantId),
        sql`${arSequences.triggerConfig}->>'system_key' = ${QUOTE_FOLLOWUP_SYSTEM_KEY}`,
      ),
    )
    .limit(1);
  if (existing[0]) {
    // Backfill casl_category on legacy installs (Phase A shipped without it,
    // so existing rows default to express_consent in the executor — wrong).
    const cfg = (existing[0].triggerConfig as Record<string, unknown> | null) ?? {};
    if (!cfg.casl_category) {
      await db
        .update(arSequences)
        .set({
          triggerConfig: {
            ...cfg,
            casl_category: 'response_to_request',
          },
        })
        .where(eq(arSequences.id, existing[0].id));
    }
    return existing[0].id;
  }

  // Templates first.
  const [smsTemplate] = await db
    .insert(arTemplates)
    .values({
      tenantId,
      name: 'Quote follow-up — SMS (24h)',
      channel: 'sms',
      bodyText: SMS_BODY,
    })
    .returning({ id: arTemplates.id });
  const [emailTemplate] = await db
    .insert(arTemplates)
    .values({
      tenantId,
      name: 'Quote follow-up — Email (48h)',
      channel: 'email',
      subject: EMAIL_SUBJECT,
      bodyHtml: EMAIL_BODY_HTML,
      bodyText: EMAIL_BODY_TEXT,
    })
    .returning({ id: arTemplates.id });

  // Sequence — triggered by `quote_sent` event.
  const [seq] = await db
    .insert(arSequences)
    .values({
      tenantId,
      name: 'Quote follow-up',
      description:
        'Auto-installed by HeyHenry. Follows up on sent quotes 24h via SMS, 48h via email.',
      status: 'active',
      version: 1,
      triggerType: 'event',
      triggerConfig: {
        event_type: 'quote_sent',
        system_key: QUOTE_FOLLOWUP_SYSTEM_KEY,
        // The customer asked for a quote — follow-up sends fall under CASL's
        // response_to_request exemption (not express_consent). The executor
        // reads this and threads it through to email_send_log/twilio_messages
        // so audits can trace the legal basis per send.
        casl_category: 'response_to_request',
      },
      allowReenrollment: true,
    })
    .returning({ id: arSequences.id });

  // Steps. delay_minutes is from enrollment time, not from previous step.
  await db.insert(arSteps).values([
    {
      sequenceId: seq.id,
      version: 1,
      position: 1,
      type: 'sms',
      delayMinutes: 24 * 60,
      templateId: smsTemplate.id,
      config: {},
    },
    {
      sequenceId: seq.id,
      version: 1,
      position: 2,
      type: 'email',
      delayMinutes: 48 * 60,
      templateId: emailTemplate.id,
      config: {},
    },
    // T+72h: no message — tag the contact so the dashboard "needs your
    // attention" card picks them up. Owner makes the personal touch.
    {
      sequenceId: seq.id,
      version: 1,
      position: 3,
      type: 'tag',
      delayMinutes: 72 * 60,
      templateId: null,
      config: { add: [NEEDS_OWNER_ATTENTION_TAG] },
    },
  ]);

  return seq.id;
}

/**
 * Resolve whether quote follow-up is enabled for a tenant. Reads from
 * `tenant_prefs(namespace='automation').data.quote_followup_enabled`.
 *
 * Defaults to **true** when no row exists (new tenants opt in by default).
 * Existing tenants are seeded to false in migration 0140 so their backlog
 * isn't auto-enrolled.
 *
 * Defensive: this lookup feeds a non-critical UI checkbox (the
 * auto-followup default on the estimate preview). A transient DB error
 * here should not crash the entire estimate preview — surface it as
 * "the default opt-in" and let the operator override as needed. Sentry
 * still captures the underlying error from the `try` block for triage.
 */
export async function resolveTenantAutoFollowupEnabled(tenantId: string): Promise<boolean> {
  try {
    const db = getDb();
    const rows = await db.execute(
      sql`SELECT data->>'quote_followup_enabled' AS v FROM public.tenant_prefs WHERE tenant_id = ${tenantId} AND namespace = 'automation' LIMIT 1`,
    );
    const value = (rows as unknown as Array<{ v: string | null }>)[0]?.v;
    if (value === null || value === undefined) return true;
    return value === 'true';
  } catch (err) {
    // Log but don't propagate — the caller is rendering a page, not
    // making a billing decision. Worst case is the default-on checkbox
    // shows opt-in when the tenant has explicitly opted out, which the
    // operator will catch on the preview before sending.
    console.error('resolveTenantAutoFollowupEnabled failed; defaulting to true', err);
    return true;
  }
}

/**
 * Plan-tier gate. Quote follow-up requires the Growth tier (or higher) and
 * an active subscription — past_due / canceled tenants can't enroll new
 * customers. In-flight enrollments are stopped at dispatch by ar/policy.ts.
 */
async function tenantHasFollowupFeature(tenantId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('tenants')
    .select('plan, subscription_status')
    .eq('id', tenantId)
    .maybeSingle();
  if (!data) return false;
  return hasFeature(
    {
      // biome-ignore lint/suspicious/noExplicitAny: tenants.plan is a Plan enum
      plan: (data.plan ?? 'starter') as any,
      // biome-ignore lint/suspicious/noExplicitAny: same
      subscriptionStatus: (data.subscription_status ?? 'trialing') as any,
    },
    'customers.followup_sequences',
  );
}

/**
 * The merged decision: should we enroll this specific quote in the
 * follow-up sequence at send time?
 *
 * Inputs:
 *   - plan tier (Growth+ required, hard gate — overrides everything)
 *   - tenant default (resolveTenantAutoFollowupEnabled)
 *   - per-quote override (null = follow tenant; boolean = explicit)
 *   - customer-level kill switch is checked at send time by ar/policy.ts —
 *     not duplicated here. Enrollment can happen even if the customer is
 *     flagged; the policy engine refuses dispatch.
 */
export async function shouldEnrollQuoteFollowup(params: {
  tenantId: string;
  perQuoteOverride: boolean | null;
}): Promise<boolean> {
  // Plan-tier check first — silently no-op if the tenant doesn't have access.
  if (!(await tenantHasFollowupFeature(params.tenantId))) return false;
  if (params.perQuoteOverride === false) return false;
  if (params.perQuoteOverride === true) return true;
  return resolveTenantAutoFollowupEnabled(params.tenantId);
}
