'use server';

/**
 * Server actions for the Change Orders workflow.
 *
 * Public actions (approve/decline) use the admin client since the homeowner
 * is unauthenticated. Authenticated actions use the RLS-aware server client.
 */

import crypto from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { getEmailBrandingForTenant } from '@/lib/email/branding';
import { sendEmail } from '@/lib/email/send';
import { changeOrderApprovalEmailHtml } from '@/lib/email/templates/change-order-approval';
import { formatCurrency } from '@/lib/pricing/calculator';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { sendSms } from '@/lib/twilio/client';
import { changeOrderApprovalSchema, changeOrderCreateSchema } from '@/lib/validators/change-order';

export type ChangeOrderActionResult =
  | { ok: true; id?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/** Generate a URL-safe random approval code. */
function generateApprovalCode(): string {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16);
}

export async function createChangeOrderAction(input: {
  project_id?: string;
  job_id?: string;
  title: string;
  description: string;
  reason?: string;
  cost_impact_cents: number;
  timeline_impact_days: number;
  affected_buckets?: string[];
  cost_breakdown?: { budget_category_id: string; amount_cents: number }[];
}): Promise<ChangeOrderActionResult> {
  const parsed = changeOrderCreateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  const approvalCode = generateApprovalCode();

  const { data, error } = await supabase
    .from('change_orders')
    .insert({
      project_id: parsed.data.project_id ?? null,
      job_id: parsed.data.job_id ?? null,
      tenant_id: tenant.id,
      title: parsed.data.title,
      description: parsed.data.description,
      reason: parsed.data.reason?.trim() || null,
      cost_impact_cents: parsed.data.cost_impact_cents,
      timeline_impact_days: parsed.data.timeline_impact_days,
      affected_buckets: parsed.data.affected_buckets,
      cost_breakdown: parsed.data.cost_breakdown.filter((r) => r.amount_cents !== 0),
      status: 'draft',
      approval_code: approvalCode,
      created_by: tenant.member.id,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to create change order.' };
  }

  if (parsed.data.project_id) {
    revalidatePath(`/projects/${parsed.data.project_id}`);
  }
  if (parsed.data.job_id) {
    revalidatePath(`/jobs/${parsed.data.job_id}`);
  }
  return { ok: true, id: data.id };
}

export async function sendChangeOrderAction(
  changeOrderId: string,
): Promise<ChangeOrderActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  // Load the change order with project OR job context. Pull phone too
  // so Slice 7 can fire SMS alongside the email — the urgency lives in
  // the SMS, not the inbox.
  const { data: co, error: coErr } = await supabase
    .from('change_orders')
    .select(
      '*, projects:project_id (id, name, customer_id, customers:customer_id (name, email, phone)), jobs:job_id (id, customer_id, customers:customer_id (name, email, phone))',
    )
    .eq('id', changeOrderId)
    .single();

  if (coErr || !co) {
    return { ok: false, error: 'Change order not found.' };
  }

  const coData = co as Record<string, unknown>;
  if (coData.status !== 'draft') {
    return { ok: false, error: 'Only draft change orders can be sent.' };
  }

  // Extract customer info from project or job (whichever this CO is linked to)
  const project = coData.projects as Record<string, unknown> | null;
  const job = coData.jobs as Record<string, unknown> | null;
  const projectName = (project?.name as string) ?? 'Job';
  const projectId = (project?.id as string) ?? (job?.id as string) ?? '';
  const customerRaw = (project?.customers ?? job?.customers) as Record<string, unknown> | null;
  const customerEmail = customerRaw?.email as string | null;
  const customerPhone = customerRaw?.phone as string | null;
  const customerName = (customerRaw?.name as string) ?? 'Customer';
  const customerFirstName = customerName.split(/\s+/)[0] || 'there';

  // Update status
  const { error: updateErr } = await supabase
    .from('change_orders')
    .update({ status: 'pending_approval', updated_at: new Date().toISOString() })
    .eq('id', changeOrderId);

  if (updateErr) {
    return { ok: false, error: `Failed to update status: ${updateErr.message}` };
  }

  // Send email if customer has email
  if (customerEmail) {
    const approvalCode = coData.approval_code as string;
    const approveUrl = `https://app.heyhenry.io/approve/${approvalCode}`;
    const costCents = coData.cost_impact_cents as number;
    const costFormatted =
      costCents >= 0 ? `+${formatCurrency(costCents)}` : `-${formatCurrency(Math.abs(costCents))}`;

    const branding = await getEmailBrandingForTenant(tenant.id);
    const html = changeOrderApprovalEmailHtml({
      businessName: branding.businessName,
      logoUrl: branding.logoUrl,
      projectName,
      changeOrderTitle: coData.title as string,
      description: coData.description as string,
      costImpactFormatted: costFormatted,
      timelineImpactDays: coData.timeline_impact_days as number,
      approveUrl,
    });

    await sendEmail({
      tenantId: tenant.id,
      to: customerEmail,
      subject: `Change order for ${projectName} — ${tenant.name}`,
      html,
      caslCategory: 'transactional',
      relatedType: 'change_order',
      relatedId: changeOrderId,
      caslEvidence: { kind: 'change_order_send', projectId, changeOrderId },
    });
  }

  // Slice 7 — SMS urgency. Email lands in an inbox; the SMS is what
  // pulls a homeowner's attention so the floor crew can start Friday.
  // Best-effort: failures here don't break the flow.
  if (customerPhone) {
    const approvalCode = coData.approval_code as string;
    const approveUrl = `https://app.heyhenry.io/approve/${approvalCode}`;
    const costCents = coData.cost_impact_cents as number;
    const costDelta =
      costCents >= 0 ? `+${formatCurrency(costCents)}` : `-${formatCurrency(Math.abs(costCents))}`;
    // Plain-language, ≤ 160 chars where possible — Twilio splits longer
    // messages into segments and they cost more.
    const body = `Hi ${customerFirstName}, quick approval needed on ${projectName}: ${coData.title} (${costDelta}). Tap to review: ${approveUrl}`;
    try {
      await sendSms({
        tenantId: tenant.id,
        to: customerPhone,
        body,
        relatedType: 'job',
        relatedId: projectId,
        caslCategory: 'transactional',
        caslEvidence: { kind: 'change_order_send', changeOrderId, projectId },
      });
    } catch (err) {
      console.error('[change-order] sms send failed:', err);
    }
  }

  // Add portal update
  await supabase.from('project_portal_updates').insert({
    project_id: projectId,
    tenant_id: tenant.id,
    type: 'system',
    title: `Change order sent for approval`,
    body: `"${coData.title}" sent to ${customerName} for review.`,
    created_by: tenant.member.id,
  });

  // Worklog
  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Change order sent',
    body: `Change order "${coData.title}" sent for approval on ${projectName}.`,
    related_type: 'project',
    related_id: projectId,
  });

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: changeOrderId };
}

/**
 * PUBLIC action: homeowner approves a change order via approval code.
 * No auth required. Uses admin client.
 */
export async function approveChangeOrderAction(
  approvalCode: string,
  approvedByNameRaw: string,
): Promise<ChangeOrderActionResult> {
  const nameParsed = changeOrderApprovalSchema.safeParse({
    approved_by_name: approvedByNameRaw,
  });
  if (!nameParsed.success) {
    return {
      ok: false,
      error: 'Please type your name to approve.',
      fieldErrors: nameParsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const admin = createAdminClient();

  // Look up change order
  const { data: co, error: coErr } = await admin
    .from('change_orders')
    .select('id, project_id, tenant_id, title, status, cost_impact_cents, affected_buckets')
    .eq('approval_code', approvalCode)
    .single();

  if (coErr || !co) {
    return { ok: false, error: 'Change order not found.' };
  }

  const coData = co as Record<string, unknown>;
  if (coData.status !== 'pending_approval') {
    return { ok: false, error: 'This change order has already been responded to.' };
  }

  const now = new Date().toISOString();
  const projectId = coData.project_id as string;
  const tenantId = coData.tenant_id as string;

  // Approve it
  const { error: updateErr } = await admin
    .from('change_orders')
    .update({
      status: 'approved',
      approved_by_name: nameParsed.data.approved_by_name,
      approved_at: now,
      updated_at: now,
    })
    .eq('id', coData.id as string);

  if (updateErr) {
    return { ok: false, error: `Failed to approve: ${updateErr.message}` };
  }

  // Update project budget: add cost delta to affected buckets
  const affectedBuckets = (coData.affected_buckets ?? []) as string[];
  const costDelta = coData.cost_impact_cents as number;

  if (affectedBuckets.length > 0 && costDelta !== 0) {
    // Distribute cost evenly across affected buckets
    const perBucket = Math.round(costDelta / affectedBuckets.length);
    for (const bucketId of affectedBuckets) {
      const { data: bucket } = await admin
        .from('project_budget_categories')
        .select('estimate_cents')
        .eq('id', bucketId)
        .single();

      if (bucket) {
        await admin
          .from('project_budget_categories')
          .update({
            estimate_cents: (bucket.estimate_cents as number) + perBucket,
            updated_at: now,
          })
          .eq('id', bucketId);
      }
    }
  }

  // Portal update
  await admin.from('project_portal_updates').insert({
    project_id: projectId,
    tenant_id: tenantId,
    type: 'system',
    title: 'Change order approved',
    body: `"${coData.title}" approved by ${nameParsed.data.approved_by_name}.`,
  });

  // Worklog
  await admin.from('worklog_entries').insert({
    tenant_id: tenantId,
    entry_type: 'system',
    title: 'Change order approved',
    body: `Change order "${coData.title}" approved by ${nameParsed.data.approved_by_name}.`,
    related_type: 'project',
    related_id: projectId,
  });

  // Notify owner/admin members per their preferences.
  await dispatchChangeOrderNotifications({
    admin,
    tenantId,
    projectId,
    title: coData.title as string,
    response: 'approved',
    byName: nameParsed.data.approved_by_name,
  }).catch((err) => console.error('[change-order] notification dispatch failed:', err));

  // Henry suggestion: create tasks for the new scope items.
  const { onChangeOrderApproved } = await import('@/server/ai/triggers');
  await onChangeOrderApproved(coData.id as string);

  return { ok: true, id: coData.id as string };
}

/**
 * PUBLIC action: homeowner declines a change order via approval code.
 * No auth required. Uses admin client.
 */
export async function declineChangeOrderAction(
  approvalCode: string,
  reason?: string,
): Promise<ChangeOrderActionResult> {
  const admin = createAdminClient();

  const { data: co, error: coErr } = await admin
    .from('change_orders')
    .select('id, project_id, tenant_id, title, status')
    .eq('approval_code', approvalCode)
    .single();

  if (coErr || !co) {
    return { ok: false, error: 'Change order not found.' };
  }

  const coData = co as Record<string, unknown>;
  if (coData.status !== 'pending_approval') {
    return { ok: false, error: 'This change order has already been responded to.' };
  }

  const now = new Date().toISOString();
  const projectId = coData.project_id as string;
  const tenantId = coData.tenant_id as string;

  const { error: updateErr } = await admin
    .from('change_orders')
    .update({
      status: 'declined',
      declined_at: now,
      declined_reason: reason?.trim() || null,
      updated_at: now,
    })
    .eq('id', coData.id as string);

  if (updateErr) {
    return { ok: false, error: `Failed to decline: ${updateErr.message}` };
  }

  // Portal update
  await admin.from('project_portal_updates').insert({
    project_id: projectId,
    tenant_id: tenantId,
    type: 'system',
    title: 'Change order declined',
    body: `"${coData.title}" was declined.${reason ? ` Reason: ${reason}` : ''}`,
  });

  // Worklog
  await admin.from('worklog_entries').insert({
    tenant_id: tenantId,
    entry_type: 'system',
    title: 'Change order declined',
    body: `Change order "${coData.title}" was declined.${reason ? ` Reason: ${reason}` : ''}`,
    related_type: 'project',
    related_id: projectId,
  });

  // Notify owner/admin members per their preferences.
  await dispatchChangeOrderNotifications({
    admin,
    tenantId,
    projectId,
    title: coData.title as string,
    response: 'declined',
    reason,
  }).catch((err) => console.error('[change-order] notification dispatch failed:', err));

  return { ok: true, id: coData.id as string };
}

/**
 * Authenticated action: owner voids a draft or pending change order.
 */
export async function voidChangeOrderAction(
  changeOrderId: string,
): Promise<ChangeOrderActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  const { data: co, error: coErr } = await supabase
    .from('change_orders')
    .select('id, project_id, title, status')
    .eq('id', changeOrderId)
    .single();

  if (coErr || !co) {
    return { ok: false, error: 'Change order not found.' };
  }

  const coData = co as Record<string, unknown>;
  if (coData.status !== 'draft' && coData.status !== 'pending_approval') {
    return { ok: false, error: 'Only draft or pending change orders can be voided.' };
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('change_orders')
    .update({ status: 'voided', updated_at: now })
    .eq('id', changeOrderId);

  if (updateErr) {
    return { ok: false, error: `Failed to void: ${updateErr.message}` };
  }

  const projectId = coData.project_id as string;

  // Portal update
  await supabase.from('project_portal_updates').insert({
    project_id: projectId,
    tenant_id: tenant.id,
    type: 'system',
    title: 'Change order voided',
    body: `"${coData.title}" has been voided.`,
    created_by: tenant.member.id,
  });

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: changeOrderId };
}

async function dispatchChangeOrderNotifications(args: {
  admin: ReturnType<typeof createAdminClient>;
  tenantId: string;
  projectId: string;
  title: string;
  response: 'approved' | 'declined';
  byName?: string;
  reason?: string;
}) {
  const { admin, tenantId, projectId, title, response, byName, reason } = args;

  const { data: members } = await admin
    .from('tenant_members')
    .select('user_id, notification_phone, notify_prefs, role')
    .eq('tenant_id', tenantId)
    .in('role', ['owner', 'admin']);

  const userIds = (members ?? []).map((m) => m.user_id as string).filter(Boolean);
  if (userIds.length === 0) return;

  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const emailByUserId = new Map<string, string>();
  for (const u of users?.users ?? []) {
    if (u.id && u.email) emailByUserId.set(u.id, u.email);
  }

  const projectUrl = `https://app.heyhenry.io/projects/${projectId}?tab=change-orders`;
  const verb = response === 'approved' ? 'approved' : 'declined';
  const preview = byName
    ? `Change order "${title}" was ${verb} by ${byName}.`
    : `Change order "${title}" was ${verb}.`;
  const body = reason ? `${preview} Reason: ${reason}` : preview;

  for (const m of members ?? []) {
    const prefs = (m.notify_prefs as Record<string, Record<string, boolean> | undefined>) ?? {};
    const want = prefs.change_order_response ?? { email: true, sms: false };

    if (want.email) {
      const email = emailByUserId.get(m.user_id as string);
      if (email) {
        await sendEmail({
          tenantId,
          to: email,
          subject: `Change order ${verb}: "${title}"`,
          html: `<p>${body}</p><p><a href="${projectUrl}">Open in HeyHenry</a></p>`,
          caslCategory: 'transactional',
          relatedType: 'change_order',
          caslEvidence: { kind: 'change_order_response_internal_notify', verb },
        }).catch((err) => console.error('[change-order] email failed:', err));
      }
    }

    if (want.sms) {
      const phone = (m.notification_phone as string | null) ?? '';
      if (phone) {
        await sendSms({
          tenantId,
          to: phone,
          body: `${body} ${projectUrl}`,
          relatedType: 'platform',
          caslCategory: 'transactional',
          caslEvidence: { kind: 'change_order_response_internal_notify', verb },
        }).catch((err) => console.error('[change-order] sms failed:', err));
      }
    }
  }
}

export async function deleteChangeOrderAction(
  changeOrderId: string,
): Promise<{ ok: boolean; error?: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  // Only allow deleting draft COs
  const { data: co } = await supabase
    .from('change_orders')
    .select('status')
    .eq('id', changeOrderId)
    .eq('tenant_id', tenant.id)
    .single();

  if (!co) return { ok: false, error: 'Change order not found.' };
  if ((co as Record<string, unknown>).status !== 'draft') {
    return {
      ok: false,
      error: 'Only draft change orders can be deleted. Use Cancel for pending ones.',
    };
  }

  const { error } = await supabase
    .from('change_orders')
    .delete()
    .eq('id', changeOrderId)
    .eq('tenant_id', tenant.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath('/jobs');
  revalidatePath('/projects');
  return { ok: true };
}
