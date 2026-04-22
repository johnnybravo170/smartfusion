'use server';

import crypto from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { getEmailBrandingForTenant } from '@/lib/email/branding';
import { sendEmail } from '@/lib/email/send';
import { estimateApprovalEmailHtml } from '@/lib/email/templates/estimate-approval';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { sendSms } from '@/lib/twilio/client';

export type EstimateActionResult =
  | { ok: true; id?: string; code?: string }
  | { ok: false; error: string };

function generateApprovalCode(): string {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16);
}

async function emitProjectEvent(
  db: ReturnType<typeof createAdminClient>,
  params: {
    tenant_id: string;
    project_id: string;
    kind: string;
    meta?: Record<string, unknown>;
    actor?: string | null;
  },
) {
  await db.from('project_events').insert({
    tenant_id: params.tenant_id,
    project_id: params.project_id,
    kind: params.kind,
    meta: params.meta ?? {},
    actor: params.actor ?? null,
  });
}

export async function sendEstimateForApprovalAction(input: {
  projectId: string;
  note?: string | null;
}): Promise<EstimateActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select(
      'id, name, estimate_status, estimate_approval_code, management_fee_rate, customers:customer_id (name, email), tenants:tenant_id (gst_rate)',
    )
    .eq('id', input.projectId)
    .single();

  if (projErr || !project) return { ok: false, error: 'Project not found.' };

  const p = project as Record<string, unknown>;
  const customerRaw = p.customers as Record<string, unknown> | null;
  const tenantRaw = p.tenants as Record<string, unknown> | null;
  const customerEmail = customerRaw?.email as string | null;
  const customerName = (customerRaw?.name as string) ?? 'Customer';

  if (!customerEmail) {
    return { ok: false, error: 'Customer has no email address on file.' };
  }

  const { data: costLines, error: clErr } = await supabase
    .from('project_cost_lines')
    .select('line_price_cents')
    .eq('project_id', input.projectId);

  if (clErr) return { ok: false, error: clErr.message };

  const lineSubtotal = (costLines ?? []).reduce(
    (s, l) => s + ((l as { line_price_cents: number }).line_price_cents ?? 0),
    0,
  );
  const mgmtRate = Number(p.management_fee_rate) || 0;
  const gstRate = Number(tenantRaw?.gst_rate) || 0;
  const mgmtFee = Math.round(lineSubtotal * mgmtRate);
  const beforeTax = lineSubtotal + mgmtFee;
  const gst = Math.round(beforeTax * gstRate);
  const total = beforeTax + gst;

  if (total <= 0) {
    return { ok: false, error: 'Add cost lines before sending the estimate.' };
  }

  const code = (p.estimate_approval_code as string | null) ?? generateApprovalCode();
  const now = new Date().toISOString();

  const { error: updErr } = await supabase
    .from('projects')
    .update({
      estimate_status: 'pending_approval',
      estimate_approval_code: code,
      estimate_sent_at: now,
      estimate_approved_at: null,
      estimate_approved_by_name: null,
      estimate_declined_at: null,
      estimate_declined_reason: null,
    })
    .eq('id', input.projectId);

  if (updErr) return { ok: false, error: updErr.message };

  const branding = await getEmailBrandingForTenant(tenant.id);
  const approveUrl = `https://app.heyhenry.io/estimate/${code}`;
  const html = estimateApprovalEmailHtml({
    businessName: branding.businessName,
    logoUrl: branding.logoUrl,
    projectName: p.name as string,
    approveUrl,
    customerName,
    note: input.note ?? null,
  });

  await sendEmail({
    tenantId: tenant.id,
    to: customerEmail,
    subject: `Estimate for ${p.name as string} — ${tenant.name}`,
    html,
  });

  const admin = createAdminClient();
  await emitProjectEvent(admin, {
    tenant_id: tenant.id,
    project_id: input.projectId,
    kind: 'estimate_sent',
    meta: { to: customerEmail, total_cents: total },
    actor: tenant.member.id,
  });

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, code };
}

export async function resetEstimateAction(input: {
  projectId: string;
}): Promise<EstimateActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('projects')
    .update({
      estimate_status: 'draft',
      estimate_approval_code: null,
      estimate_sent_at: null,
      estimate_approved_at: null,
      estimate_approved_by_name: null,
      estimate_declined_at: null,
      estimate_declined_reason: null,
    })
    .eq('id', input.projectId);

  if (error) return { ok: false, error: error.message };

  const admin = createAdminClient();
  await emitProjectEvent(admin, {
    tenant_id: tenant.id,
    project_id: input.projectId,
    kind: 'estimate_reset',
    actor: tenant.member.id,
  });

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true };
}

export async function approveEstimateAction(
  approvalCode: string,
  approvedByNameRaw: string,
): Promise<EstimateActionResult> {
  const name = approvedByNameRaw.trim();
  if (!name) return { ok: false, error: 'Please type your name to approve.' };

  const admin = createAdminClient();

  const { data: project, error: projErr } = await admin
    .from('projects')
    .select('id, tenant_id, name, estimate_status')
    .eq('estimate_approval_code', approvalCode)
    .single();

  if (projErr || !project) return { ok: false, error: 'Estimate not found.' };

  const p = project as Record<string, unknown>;
  if (p.estimate_status !== 'pending_approval') {
    return { ok: false, error: 'This estimate has already been responded to.' };
  }

  const now = new Date().toISOString();
  const { error: updErr } = await admin
    .from('projects')
    .update({
      estimate_status: 'approved',
      estimate_approved_at: now,
      estimate_approved_by_name: name,
    })
    .eq('id', p.id as string);

  if (updErr) return { ok: false, error: updErr.message };

  await emitProjectEvent(admin, {
    tenant_id: p.tenant_id as string,
    project_id: p.id as string,
    kind: 'estimate_approved',
    meta: { approved_by: name },
    actor: 'customer',
  });

  return { ok: true, id: p.id as string };
}

export async function declineEstimateAction(
  approvalCode: string,
  reason?: string,
): Promise<EstimateActionResult> {
  const admin = createAdminClient();

  const { data: project, error: projErr } = await admin
    .from('projects')
    .select('id, tenant_id, name, estimate_status')
    .eq('estimate_approval_code', approvalCode)
    .single();

  if (projErr || !project) return { ok: false, error: 'Estimate not found.' };

  const p = project as Record<string, unknown>;
  if (p.estimate_status !== 'pending_approval') {
    return { ok: false, error: 'This estimate has already been responded to.' };
  }

  const now = new Date().toISOString();
  const { error: updErr } = await admin
    .from('projects')
    .update({
      estimate_status: 'declined',
      estimate_declined_at: now,
      estimate_declined_reason: reason?.trim() || null,
    })
    .eq('id', p.id as string);

  if (updErr) return { ok: false, error: updErr.message };

  await emitProjectEvent(admin, {
    tenant_id: p.tenant_id as string,
    project_id: p.id as string,
    kind: 'estimate_declined',
    meta: reason ? { reason } : {},
    actor: 'customer',
  });

  return { ok: true, id: p.id as string };
}

export async function logEstimateViewAction(input: {
  approvalCode: string;
  sessionId?: string;
  userAgent?: string;
  ipHash?: string;
}): Promise<{ ok: boolean }> {
  const admin = createAdminClient();

  const { data: project } = await admin
    .from('projects')
    .select('id, tenant_id')
    .eq('estimate_approval_code', input.approvalCode)
    .single();

  if (!project) return { ok: false };

  const p = project as Record<string, unknown>;
  await admin.from('public_page_views').insert({
    tenant_id: p.tenant_id as string,
    resource_type: 'estimate',
    resource_id: p.id as string,
    session_id: input.sessionId ?? null,
    ip_hash: input.ipHash ?? null,
    user_agent: input.userAgent ?? null,
  });

  await emitProjectEvent(admin, {
    tenant_id: p.tenant_id as string,
    project_id: p.id as string,
    kind: 'estimate_viewed',
    actor: 'customer',
  });

  return { ok: true };
}

// ============================================================================
// Customer feedback on pending estimates
// ============================================================================

export type FeedbackComment = {
  /** Null or missing → general comment (shown at the bottom, not tied to a line). */
  costLineId?: string | null;
  body: string;
};

/**
 * Customer submits feedback on the estimate. The estimate status does not
 * change — we just write comments. The operator sees them on the dashboard
 * with an unseen badge and can decide whether to revise/resend.
 *
 * Also fires per-member notifications (email/sms) based on tenant_members
 * notify_prefs. Notification failures are logged but don't block the write.
 */
export async function submitEstimateFeedbackAction(
  approvalCode: string,
  comments: FeedbackComment[],
): Promise<EstimateActionResult> {
  const cleaned = comments
    .map((c) => ({
      costLineId: c.costLineId ?? null,
      body: (c.body ?? '').trim(),
    }))
    .filter((c) => c.body.length > 0);

  if (cleaned.length === 0) {
    return { ok: false, error: 'Nothing to send — add a comment first.' };
  }

  const admin = createAdminClient();

  const { data: project } = await admin
    .from('projects')
    .select('id, tenant_id, name, estimate_status, customers:customer_id (name)')
    .eq('estimate_approval_code', approvalCode)
    .maybeSingle();

  if (!project) return { ok: false, error: 'Estimate not found.' };

  const p = project as Record<string, unknown>;
  const projectId = p.id as string;
  const tenantId = p.tenant_id as string;

  const rows = cleaned.map((c) => ({
    project_id: projectId,
    tenant_id: tenantId,
    cost_line_id: c.costLineId,
    body: c.body,
  }));

  const { error: insErr } = await admin.from('project_estimate_comments').insert(rows);
  if (insErr) return { ok: false, error: insErr.message };

  await emitProjectEvent(admin, {
    tenant_id: tenantId,
    project_id: projectId,
    kind: 'estimate_feedback_submitted',
    meta: { count: rows.length },
    actor: 'customer',
  });

  // Fire notifications per tenant member prefs. Best-effort — one bad
  // member shouldn't block the others.
  const customerName =
    ((p.customers as Record<string, unknown> | null)?.name as string | undefined) ?? 'the customer';
  const projectName = (p.name as string) ?? 'their project';

  await dispatchFeedbackNotifications({
    admin,
    tenantId,
    projectId,
    projectName,
    customerName,
    commentCount: rows.length,
  }).catch((err) => {
    console.error('[feedback] notification dispatch failed:', err);
  });

  return { ok: true, id: projectId };
}

async function dispatchFeedbackNotifications(args: {
  admin: ReturnType<typeof createAdminClient>;
  tenantId: string;
  projectId: string;
  projectName: string;
  customerName: string;
  commentCount: number;
}) {
  const { admin, tenantId, projectId, projectName, customerName, commentCount } = args;

  // Scope notifications to operator-level roles. Workers (field crew) and
  // any future role-restricted staff should NEVER see customer-pricing
  // feedback — that's business-side communication.
  const { data: members } = await admin
    .from('tenant_members')
    .select('user_id, first_name, notification_phone, notify_prefs, role')
    .eq('tenant_id', tenantId)
    .in('role', ['owner', 'admin']);

  const userIds = (members ?? []).map((m) => m.user_id as string).filter(Boolean);
  if (userIds.length === 0) return;

  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const emailByUserId = new Map<string, string>();
  for (const u of users?.users ?? []) {
    if (u.id && u.email) emailByUserId.set(u.id, u.email);
  }

  const feedbackUrl = `https://app.heyhenry.io/projects/${projectId}?tab=estimate#feedback`;
  const preview = `${customerName} left ${commentCount} comment${commentCount === 1 ? '' : 's'} on the estimate for ${projectName}.`;

  for (const m of members ?? []) {
    const prefs = (m.notify_prefs as Record<string, Record<string, boolean> | undefined>) ?? {};
    const want = prefs.customer_feedback ?? { email: true, sms: false };

    if (want.email) {
      const email = emailByUserId.get(m.user_id as string);
      if (email) {
        await sendEmail({
          tenantId,
          to: email,
          subject: `New estimate feedback from ${customerName}`,
          html: `<p>${preview}</p><p><a href="${feedbackUrl}">Open in HeyHenry</a></p>`,
        }).catch((err) => console.error('[feedback] email send failed:', err));
      }
    }

    if (want.sms) {
      const phone = (m.notification_phone as string | null) ?? '';
      if (phone) {
        await sendSms({
          tenantId,
          to: phone,
          body: `${preview} ${feedbackUrl}`,
          relatedType: 'platform',
        }).catch((err) => console.error('[feedback] sms send failed:', err));
      }
    }
  }
}

export async function markEstimateFeedbackSeenAction(input: {
  projectId: string;
  commentIds?: string[]; // if omitted, mark all for this project seen
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  let query = supabase
    .from('project_estimate_comments')
    .update({ seen_at: new Date().toISOString() })
    .eq('project_id', input.projectId)
    .is('seen_at', null);

  if (input.commentIds && input.commentIds.length > 0) {
    query = query.in('id', input.commentIds);
  }

  const { error } = await query;
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true };
}
