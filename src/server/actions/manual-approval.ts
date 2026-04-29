'use server';

/**
 * Manual override actions for estimate + change-order approval.
 *
 * When a customer says yes/no over text, phone, or in person, the
 * operator marks the decision on their behalf. We capture:
 *   - method (text/phone/in-person/email)
 *   - customer's stated name (for the "approved by" record)
 *   - optional free-text notes
 *   - optional proof attachments (screenshots of text, email, etc.)
 *
 * All four fields are stored on the target row; files go to the
 * `approval-proofs` storage bucket under
 *   {tenant_id}/{resource_type}/{resource_id}/{uuid}.{ext}
 *
 * Transition semantics mirror the digital-path actions:
 *   - manuallyApproveEstimate   → lifecycle_stage='active'
 *   - manuallyDeclineEstimate   → lifecycle_stage='declined'
 *   - manuallyApproveChangeOrder → applies cost delta to buckets
 *   - manuallyDeclineChangeOrder → no budget effect
 *
 * See PROJECT_LIFECYCLE_PLAN.md for the broader lifecycle context.
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  MANUAL_APPROVAL_METHODS,
  manualApprovalMethodLabels,
} from '@/lib/validators/manual-approval';
import { applyV2ChangeOrderDiff } from '@/server/actions/change-orders';

const PROOFS_BUCKET = 'approval-proofs';
const MAX_PROOF_BYTES = 10 * 1024 * 1024;
const MAX_PROOF_FILES = 10;

function extFromContentType(contentType: string): string {
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/heic' || contentType === 'image/heif') return 'heic';
  if (contentType === 'application/pdf') return 'pdf';
  return 'jpg';
}

type ManualApprovalResult = { ok: true; id: string } | { ok: false; error: string };

const baseSchema = z.object({
  method: z.enum(MANUAL_APPROVAL_METHODS),
  notes: z.string().trim().max(2000).optional(),
});

const approveSchema = baseSchema.extend({
  customer_name: z.string().trim().min(1, 'Customer name is required.').max(200),
});

const declineSchema = baseSchema.extend({
  reason: z.string().trim().max(2000).optional(),
});

// ============================================================================
// File upload helper — shared by both resource types
// ============================================================================

/**
 * Upload any proof files from the FormData to the approval-proofs bucket.
 * Returns the storage paths (relative to the bucket). Max 10 files, 10MB each.
 */
async function uploadProofsFromFormData(
  formData: FormData,
  opts: {
    tenantId: string;
    resourceType: 'estimate' | 'change_order';
    resourceId: string;
  },
): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  const files = formData.getAll('proof').filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { ok: true, paths: [] };
  if (files.length > MAX_PROOF_FILES) {
    return { ok: false, error: `At most ${MAX_PROOF_FILES} proof files.` };
  }
  for (const f of files) {
    if (f.size > MAX_PROOF_BYTES) {
      return { ok: false, error: `"${f.name}" is larger than 10MB.` };
    }
  }

  const admin = createAdminClient();
  const paths: string[] = [];
  for (const file of files) {
    const ext = extFromContentType(file.type);
    const path = `${opts.tenantId}/${opts.resourceType}/${opts.resourceId}/${randomUUID()}.${ext}`;
    const { error } = await admin.storage
      .from(PROOFS_BUCKET)
      .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (error) return { ok: false, error: `Proof upload failed: ${error.message}` };
    paths.push(path);
  }
  return { ok: true, paths };
}

// ============================================================================
// Estimate: manual approve / decline
// ============================================================================

/**
 * Operator marks a sent estimate as approved on the customer's behalf.
 * Requires the estimate to currently be `pending_approval` (same guard
 * as the digital approveEstimateAction). Writes method + proof + notes
 * and flips lifecycle to `active`.
 */
export async function manuallyApproveEstimateAction(
  formData: FormData,
): Promise<ManualApprovalResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };

  const projectId = formData.get('project_id') as string | null;
  if (!projectId) return { ok: false, error: 'Missing project id.' };

  const parsed = approveSchema.safeParse({
    method: formData.get('method'),
    customer_name: formData.get('customer_name'),
    notes: formData.get('notes') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const admin = createAdminClient();

  const { data: project, error: projErr } = await admin
    .from('projects')
    .select('id, tenant_id, name, estimate_status')
    .eq('id', projectId)
    .eq('tenant_id', tenant.id)
    .single();
  if (projErr || !project) return { ok: false, error: 'Project not found.' };
  if (project.estimate_status !== 'pending_approval' && project.estimate_status !== 'draft') {
    return {
      ok: false,
      error: 'Estimate must be a draft or awaiting approval.',
    };
  }
  const bypassedSend = project.estimate_status === 'draft';

  const uploaded = await uploadProofsFromFormData(formData, {
    tenantId: tenant.id,
    resourceType: 'estimate',
    resourceId: projectId,
  });
  if (!uploaded.ok) return uploaded;

  const now = new Date().toISOString();
  const { error: updErr } = await admin
    .from('projects')
    .update({
      estimate_status: 'approved',
      lifecycle_stage: 'active',
      estimate_approved_at: now,
      estimate_approved_by_name: parsed.data.customer_name,
      estimate_approval_method: parsed.data.method,
      estimate_approved_by_member_id: tenant.member.id,
      estimate_approval_proof_paths: uploaded.paths,
      estimate_approval_notes: parsed.data.notes || null,
    })
    .eq('id', projectId);
  if (updErr) return { ok: false, error: updErr.message };

  await admin.from('project_events').insert({
    tenant_id: tenant.id,
    project_id: projectId,
    kind: 'estimate_approved',
    meta: {
      approved_by: parsed.data.customer_name,
      method: parsed.data.method,
      manual: true,
      bypassed_send: bypassedSend,
      proof_count: uploaded.paths.length,
    },
    actor: tenant.member.id,
  });

  await admin.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Estimate approved (manual)',
    body: `Estimate for "${project.name}" marked approved by ${parsed.data.customer_name} via ${manualApprovalMethodLabels[parsed.data.method]}${bypassedSend ? ' — recorded without sending to customer.' : '.'}`,
    related_type: 'project',
    related_id: projectId,
  });

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: projectId };
}

/**
 * Operator marks a sent estimate as declined on the customer's behalf.
 */
export async function manuallyDeclineEstimateAction(
  formData: FormData,
): Promise<ManualApprovalResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };

  const projectId = formData.get('project_id') as string | null;
  if (!projectId) return { ok: false, error: 'Missing project id.' };

  const parsed = declineSchema.safeParse({
    method: formData.get('method'),
    reason: formData.get('reason') || undefined,
    notes: formData.get('notes') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const admin = createAdminClient();
  const { data: project, error: projErr } = await admin
    .from('projects')
    .select('id, tenant_id, name, estimate_status')
    .eq('id', projectId)
    .eq('tenant_id', tenant.id)
    .single();
  if (projErr || !project) return { ok: false, error: 'Project not found.' };
  if (project.estimate_status !== 'pending_approval' && project.estimate_status !== 'draft') {
    return { ok: false, error: 'Estimate must be a draft or awaiting approval.' };
  }
  const bypassedSend = project.estimate_status === 'draft';

  const uploaded = await uploadProofsFromFormData(formData, {
    tenantId: tenant.id,
    resourceType: 'estimate',
    resourceId: projectId,
  });
  if (!uploaded.ok) return uploaded;

  const now = new Date().toISOString();
  const { error: updErr } = await admin
    .from('projects')
    .update({
      estimate_status: 'declined',
      lifecycle_stage: 'declined',
      estimate_declined_at: now,
      estimate_declined_reason: parsed.data.reason || null,
      estimate_approval_method: parsed.data.method,
      estimate_approved_by_member_id: tenant.member.id,
      estimate_approval_proof_paths: uploaded.paths,
      estimate_approval_notes: parsed.data.notes || null,
    })
    .eq('id', projectId);
  if (updErr) return { ok: false, error: updErr.message };

  await admin.from('project_events').insert({
    tenant_id: tenant.id,
    project_id: projectId,
    kind: 'estimate_declined',
    meta: {
      method: parsed.data.method,
      manual: true,
      bypassed_send: bypassedSend,
      reason: parsed.data.reason ?? null,
      proof_count: uploaded.paths.length,
    },
    actor: tenant.member.id,
  });

  await admin.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Estimate declined (manual)',
    body: `Estimate for "${project.name}" marked declined via ${manualApprovalMethodLabels[parsed.data.method]}${bypassedSend ? ' — recorded without sending to customer.' : '.'}`,
    related_type: 'project',
    related_id: projectId,
  });

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id: projectId };
}

// ============================================================================
// Change order: manual approve / decline
// ============================================================================

/**
 * Operator marks a sent change order as approved on the customer's behalf.
 * Applies cost delta to affected buckets, same as the digital path.
 */
export async function manuallyApproveChangeOrderAction(
  formData: FormData,
): Promise<ManualApprovalResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const changeOrderId = formData.get('change_order_id') as string | null;
  if (!changeOrderId) return { ok: false, error: 'Missing change order id.' };

  const parsed = approveSchema.safeParse({
    method: formData.get('method'),
    customer_name: formData.get('customer_name'),
    notes: formData.get('notes') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const admin = createAdminClient();
  const { data: co, error: coErr } = await admin
    .from('change_orders')
    .select(
      'id, project_id, tenant_id, title, status, cost_impact_cents, affected_buckets, flow_version',
    )
    .eq('id', changeOrderId)
    .eq('tenant_id', tenant.id)
    .single();
  if (coErr || !co) return { ok: false, error: 'Change order not found.' };
  if (co.status !== 'pending_approval' && co.status !== 'draft') {
    return { ok: false, error: 'Change order must be a draft or awaiting approval.' };
  }
  const bypassedSend = co.status === 'draft';

  const uploaded = await uploadProofsFromFormData(formData, {
    tenantId: tenant.id,
    resourceType: 'change_order',
    resourceId: changeOrderId,
  });
  if (!uploaded.ok) return uploaded;

  const now = new Date().toISOString();
  const { error: updErr } = await admin
    .from('change_orders')
    .update({
      status: 'approved',
      approved_by_name: parsed.data.customer_name,
      approved_at: now,
      approval_method: parsed.data.method,
      approved_by_member_id: tenant.member.id,
      approval_proof_paths: uploaded.paths,
      approval_notes: parsed.data.notes || null,
      updated_at: now,
    })
    .eq('id', changeOrderId);
  if (updErr) return { ok: false, error: updErr.message };

  // Mirror the digital approve path. v2 line-diff COs apply the diff to
  // cost_lines + budget_categories; v1 keeps legacy even-distribute.
  const flowVersion = ((co as { flow_version?: number | null }).flow_version ?? 1) as number;
  if (flowVersion === 2) {
    await applyV2ChangeOrderDiff(admin, changeOrderId);
  } else {
    const affectedBuckets = (co.affected_buckets ?? []) as string[];
    const costDelta = (co.cost_impact_cents as number) ?? 0;
    if (affectedBuckets.length > 0 && costDelta !== 0) {
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
  }

  await admin.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Change order approved (manual)',
    body: `Change order "${co.title}" marked approved by ${parsed.data.customer_name} via ${manualApprovalMethodLabels[parsed.data.method]}${bypassedSend ? ' — recorded without sending to customer.' : '.'}`,
    related_type: 'project',
    related_id: co.project_id,
  });

  revalidatePath(`/projects/${co.project_id}`);
  return { ok: true, id: changeOrderId };
}

/**
 * Operator marks a sent change order as declined on the customer's behalf.
 */
export async function manuallyDeclineChangeOrderAction(
  formData: FormData,
): Promise<ManualApprovalResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const changeOrderId = formData.get('change_order_id') as string | null;
  if (!changeOrderId) return { ok: false, error: 'Missing change order id.' };

  const parsed = declineSchema.safeParse({
    method: formData.get('method'),
    reason: formData.get('reason') || undefined,
    notes: formData.get('notes') || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const admin = createAdminClient();
  const { data: co, error: coErr } = await admin
    .from('change_orders')
    .select('id, project_id, tenant_id, title, status')
    .eq('id', changeOrderId)
    .eq('tenant_id', tenant.id)
    .single();
  if (coErr || !co) return { ok: false, error: 'Change order not found.' };
  if (co.status !== 'pending_approval' && co.status !== 'draft') {
    return { ok: false, error: 'Change order must be a draft or awaiting approval.' };
  }
  const bypassedSend = co.status === 'draft';

  const uploaded = await uploadProofsFromFormData(formData, {
    tenantId: tenant.id,
    resourceType: 'change_order',
    resourceId: changeOrderId,
  });
  if (!uploaded.ok) return uploaded;

  const now = new Date().toISOString();
  const { error: updErr } = await admin
    .from('change_orders')
    .update({
      status: 'declined',
      declined_at: now,
      declined_reason: parsed.data.reason || null,
      approval_method: parsed.data.method,
      approved_by_member_id: tenant.member.id,
      approval_proof_paths: uploaded.paths,
      approval_notes: parsed.data.notes || null,
      updated_at: now,
    })
    .eq('id', changeOrderId);
  if (updErr) return { ok: false, error: updErr.message };

  await admin.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Change order declined (manual)',
    body: `Change order "${co.title}" marked declined via ${manualApprovalMethodLabels[parsed.data.method]}${bypassedSend ? ' — recorded without sending to customer.' : '.'}`,
    related_type: 'project',
    related_id: co.project_id,
  });

  revalidatePath(`/projects/${co.project_id}`);
  return { ok: true, id: changeOrderId };
}
