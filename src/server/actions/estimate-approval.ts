'use server';

import crypto from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { sendEmail } from '@/lib/email/send';
import { estimateApprovalEmailHtml } from '@/lib/email/templates/estimate-approval';
import { formatCurrency } from '@/lib/pricing/calculator';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

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
}): Promise<EstimateActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select(
      'id, name, estimate_status, estimate_approval_code, management_fee_rate, customers:customer_id (name, email)',
    )
    .eq('id', input.projectId)
    .single();

  if (projErr || !project) return { ok: false, error: 'Project not found.' };

  const p = project as Record<string, unknown>;
  const customerRaw = p.customers as Record<string, unknown> | null;
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
  const mgmtFee = Math.round(lineSubtotal * mgmtRate);
  const total = lineSubtotal + mgmtFee;

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

  const approveUrl = `https://app.heyhenry.io/estimate/${code}`;
  const html = estimateApprovalEmailHtml({
    businessName: tenant.name,
    projectName: p.name as string,
    totalFormatted: formatCurrency(total),
    approveUrl,
    customerName,
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
