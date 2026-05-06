/**
 * SMS customer-reply router.
 *
 * Phase 3 of PROJECT_MESSAGING_PLAN.md. Resolves an inbound SMS from a
 * customer phone to an exact (tenant_id, project_id) tuple, then inserts
 * into project_messages.
 *
 * Resolution is simpler than email because SMS has no In-Reply-To
 * headers and no body footer (SMS body is too short to embed a token
 * unobtrusively). Single tier:
 *
 *   Recent outbound match — among tenants where this phone is a
 *   customer, find the one(s) with outbound SMS to this number in the
 *   last 30 days. If exactly one, use it. Else bounce.
 *
 * Multi-tenant collision case: customer has TWO contractors who've
 * texted them recently, both via HeyHenry. The existing inbound
 * webhook today uses a shared platform Twilio number (per-tenant
 * numbers deferred to a later infra phase), so the To address can't
 * disambiguate. We bounce with a reply SMS asking the customer to
 * specify the project.
 *
 * On null, the caller bounces. Privacy guarantee: never surface a
 * reply to the wrong tenant — bounce on ambiguity.
 */

import { dispatchCustomerMessageToOperators } from '@/lib/portal/customer-message-operator-notify';
import { createAdminClient } from '@/lib/supabase/admin';

export type SmsCustomerCandidate = {
  customerId: string;
  tenantId: string;
  projectId: string;
  customerName: string;
};

export type SmsResolvedProject = {
  tenantId: string;
  projectId: string;
  customerId: string;
  customerName: string;
};

/**
 * List every (tenant, project, customer) where this phone is on a
 * non-cancelled active project.
 */
async function listCustomerCandidatesForPhone(phone: string): Promise<SmsCustomerCandidate[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('customers')
    .select(
      'id, name, tenant_id, projects:projects!projects_customer_id_fkey (id, lifecycle_stage)',
    )
    .eq('phone', phone)
    .is('deleted_at', null);

  if (error || !data) return [];

  const out: SmsCustomerCandidate[] = [];
  for (const row of data as Array<Record<string, unknown>>) {
    const tenantId = row.tenant_id as string;
    const customerId = row.id as string;
    const customerName = (row.name as string) ?? 'Customer';
    const projects = (row.projects as Array<Record<string, unknown>> | null) ?? [];
    for (const p of projects) {
      const stage = p.lifecycle_stage as string;
      if (stage === 'cancelled') continue;
      out.push({
        customerId,
        tenantId,
        projectId: p.id as string,
        customerName,
      });
    }
  }
  return out;
}

export async function resolveProjectForSmsReply(
  fromPhone: string,
): Promise<SmsResolvedProject | null> {
  const candidates = await listCustomerCandidatesForPhone(fromPhone);
  if (candidates.length === 0) return null;

  // Single candidate — easy case, the common one.
  if (candidates.length === 1) {
    return {
      tenantId: candidates[0].tenantId,
      projectId: candidates[0].projectId,
      customerId: candidates[0].customerId,
      customerName: candidates[0].customerName,
    };
  }

  // Multiple — disambiguate via recent outbound. Among the candidate
  // tenants, find which one(s) sent this phone an SMS in the last 30
  // days. If exactly one, use it. Else bounce.
  const admin = createAdminClient();
  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const recents: SmsCustomerCandidate[] = [];
  for (const c of candidates) {
    const { count } = await admin
      .from('twilio_messages')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', c.tenantId)
      .eq('direction', 'outbound')
      .eq('to_number', fromPhone)
      .gte('created_at', sinceIso);
    if ((count ?? 0) > 0) recents.push(c);
  }

  // Dedupe by tenant — multiple projects on same tenant should pick the
  // most-recent project among the recent set.
  const tenantsWithRecent = new Set(recents.map((r) => r.tenantId));
  if (tenantsWithRecent.size === 1) {
    // Single tenant; pick the project with most-recent outbound to this
    // phone within that tenant.
    const tenantCandidates = recents.filter((r) => r.tenantId === [...tenantsWithRecent][0]);
    if (tenantCandidates.length === 1) {
      const c = tenantCandidates[0];
      return {
        tenantId: c.tenantId,
        projectId: c.projectId,
        customerId: c.customerId,
        customerName: c.customerName,
      };
    }
    // Multiple projects on same tenant — pick most-recent by related_id.
    const { data: lastMsg } = await admin
      .from('twilio_messages')
      .select('related_id')
      .eq('tenant_id', tenantCandidates[0].tenantId)
      .eq('direction', 'outbound')
      .eq('to_number', fromPhone)
      .eq('related_type', 'job')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const recentProjectId = (lastMsg?.related_id as string | undefined) ?? null;
    const matched = tenantCandidates.find((c) => c.projectId === recentProjectId);
    if (matched) {
      return {
        tenantId: matched.tenantId,
        projectId: matched.projectId,
        customerId: matched.customerId,
        customerName: matched.customerName,
      };
    }
    // Fall through to first project on this tenant — best we can do
    // without breaking the privacy contract (still within the right
    // tenant; project might not be the absolute right one).
    const first = tenantCandidates[0];
    return {
      tenantId: first.tenantId,
      projectId: first.projectId,
      customerId: first.customerId,
      customerName: first.customerName,
    };
  }

  // Zero or multiple tenants with recent outbound — bounce.
  return null;
}

export type SmsHandlerResult =
  | { ok: true; messageId: string; tenantId: string; projectId: string }
  | { ok: false; reason: 'unresolved' };

export async function handleCustomerInboundSms(input: {
  twilioSid: string;
  fromPhone: string;
  toPhone: string;
  body: string;
}): Promise<SmsHandlerResult> {
  const resolved = await resolveProjectForSmsReply(input.fromPhone);
  if (!resolved) return { ok: false, reason: 'unresolved' };

  const body = input.body.trim().slice(0, 10_000);
  if (!body) return { ok: false, reason: 'unresolved' };

  const admin = createAdminClient();
  const { data: inserted, error } = await admin
    .from('project_messages')
    .insert({
      tenant_id: resolved.tenantId,
      project_id: resolved.projectId,
      sender_kind: 'customer',
      sender_label: resolved.customerName,
      channel: 'sms',
      direction: 'inbound',
      body,
      external_id: input.twilioSid,
      read_by_customer_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error || !inserted) {
    console.error('[sms-customer-router] insert failed', error);
    return { ok: false, reason: 'unresolved' };
  }

  // Fire immediate operator notification.
  try {
    await dispatchCustomerMessageToOperators({
      admin,
      tenantId: resolved.tenantId,
      projectId: resolved.projectId,
      customerName: resolved.customerName,
      body,
    });
  } catch (err) {
    console.error('[sms-customer-router] operator notify failed', err);
  }

  return {
    ok: true,
    messageId: inserted.id as string,
    tenantId: resolved.tenantId,
    projectId: resolved.projectId,
  };
}
