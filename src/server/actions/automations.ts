'use server';

/**
 * Tenant-level automation toggles. All flags live under
 * `tenant_prefs(namespace='automation').data` as a single jsonb blob.
 *
 * Read helpers live in `src/lib/ar/system-sequences.ts` so the AR engine
 * can resolve them at enrollment time.
 */

import { revalidatePath } from 'next/cache';
import { emitArEvent } from '@/lib/ar/event-bus';
import {
  ensureQuoteFollowupSequence,
  NEEDS_OWNER_ATTENTION_TAG,
  shouldEnrollQuoteFollowup,
} from '@/lib/ar/system-sequences';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export type AutomationActionResult = { ok: true } | { ok: false; error: string };

export async function setAutoQuoteFollowupAction(
  enabled: boolean,
): Promise<AutomationActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const admin = createAdminClient();

  // Read existing namespace data so we don't blow away other automation flags.
  const { data: existing } = await admin
    .from('tenant_prefs')
    .select('data')
    .eq('tenant_id', tenant.id)
    .eq('namespace', 'automation')
    .maybeSingle();

  const merged = {
    ...((existing?.data as Record<string, unknown> | null) ?? {}),
    quote_followup_enabled: enabled,
  };

  const { error } = await admin.from('tenant_prefs').upsert(
    {
      tenant_id: tenant.id,
      namespace: 'automation',
      data: merged,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_id,namespace' },
  );

  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/automations');
  return { ok: true };
}

/**
 * Manually enroll a stale project-based estimate into the quote follow-up
 * sequence. Used by the /quotes/stale page so the operator can opt their
 * existing backlog into autopilot one quote at a time (or in bulk).
 *
 * Unlike sendEstimateForApprovalAction, this does NOT re-send the estimate
 * email — it only creates the AR enrollment so future follow-up steps fire.
 * The customer-level kill switch is checked at dispatch by ar/policy.ts.
 */
export async function enrollStaleQuoteFollowupAction(input: {
  projectId: string;
}): Promise<AutomationActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  // Plan gate is enforced inside shouldEnrollQuoteFollowup; if the tenant
  // doesn't have access we silently no-op with a friendly message.
  const enroll = await shouldEnrollQuoteFollowup({
    tenantId: tenant.id,
    perQuoteOverride: true,
  });
  if (!enroll) {
    return {
      ok: false,
      error: 'Quote follow-up is not available on your current plan.',
    };
  }

  const supabase = await createClient();
  const { data: project } = await supabase
    .from('projects')
    .select('id, name, customers:customer_id (name, email, phone, do_not_auto_message)')
    .eq('id', input.projectId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!project) return { ok: false, error: 'Project not found.' };

  const p = project as Record<string, unknown>;
  const customerRaw = p.customers as Record<string, unknown> | null;
  const email = customerRaw?.email as string | null;
  if (!email) return { ok: false, error: 'Customer has no email on file.' };
  if (customerRaw?.do_not_auto_message) {
    return { ok: false, error: 'Customer has opted out of automated messages.' };
  }

  await ensureQuoteFollowupSequence(tenant.id);
  const customerName = (customerRaw?.name as string) ?? 'Customer';
  const [firstName, ...rest] = customerName.split(' ');

  await emitArEvent({
    tenantId: tenant.id,
    eventType: 'quote_sent',
    payload: {
      project_id: input.projectId,
      project_name: p.name,
      from_name: tenant.name,
      enrolled_from: 'stale_quotes',
    },
    contact: {
      email,
      phone: (customerRaw?.phone as string | null) ?? null,
      firstName: firstName ?? null,
      lastName: rest.join(' ') || null,
    },
  });

  revalidatePath('/quotes/stale');
  return { ok: true };
}

/**
 * Remove the `needs_owner_attention` tag from a contact — the owner has
 * personally followed up, so it can drop off the Money-at-Risk dashboard.
 */
export async function clearMoneyAtRiskAction(input: {
  contactId: string;
}): Promise<AutomationActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const admin = createAdminClient();
  const { error } = await admin
    .from('ar_contact_tags')
    .delete()
    .eq('contact_id', input.contactId)
    .eq('tag', NEEDS_OWNER_ATTENTION_TAG);

  if (error) return { ok: false, error: error.message };

  revalidatePath('/dashboard');
  return { ok: true };
}
