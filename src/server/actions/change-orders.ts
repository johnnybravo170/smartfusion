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

type ApplyWarning = {
  code: 'orphaned_line' | 'envelope_missing' | 'state_diverged';
  message: string;
  affected_id?: string;
};

/**
 * Apply a v2 line-diff change order to the underlying baseline. Idempotent:
 * skipped when applied_at is already set. Best-effort: missing rows
 * (deleted between CO creation and approval) are logged as warnings rather
 * than failing the apply, since the customer has already approved and
 * unapproving isn't an option.
 *
 * Caller should already have flipped the parent CO to status='approved'
 * before calling this. The function:
 *   - reads change_order_lines for the CO
 *   - applies each row's action to project_cost_lines / project_budget_categories
 *   - writes applied_at + apply_warnings on the parent CO
 *
 * Returns the warnings array for the caller to surface in worklog/UI.
 *
 * No-op for v1 COs (flow_version=1) — they keep the legacy
 * even-distribute behavior in the calling action.
 */
export async function applyV2ChangeOrderDiff(
  admin: ReturnType<typeof createAdminClient>,
  changeOrderId: string,
): Promise<{ applied: boolean; warnings: ApplyWarning[]; error?: string }> {
  const { data: co, error: coErr } = await admin
    .from('change_orders')
    .select('id, project_id, flow_version, applied_at')
    .eq('id', changeOrderId)
    .single();
  if (coErr || !co) return { applied: false, warnings: [], error: coErr?.message };

  if (co.flow_version !== 2) return { applied: false, warnings: [] };
  if (co.applied_at) return { applied: true, warnings: [] }; // idempotent

  const { data: lines, error: linesErr } = await admin
    .from('change_order_lines')
    .select(
      'id, action, original_line_id, budget_category_id, category, label, qty, unit, unit_cost_cents, unit_price_cents, line_cost_cents, line_price_cents, notes, before_snapshot',
    )
    .eq('change_order_id', changeOrderId);
  if (linesErr) return { applied: false, warnings: [], error: linesErr.message };

  const warnings: ApplyWarning[] = [];
  const projectId = co.project_id as string;
  const now = new Date().toISOString();

  for (const raw of lines ?? []) {
    const d = raw as {
      action: 'add' | 'modify' | 'remove' | 'modify_envelope';
      original_line_id: string | null;
      budget_category_id: string | null;
      category: string | null;
      label: string | null;
      qty: number | null;
      unit: string | null;
      unit_cost_cents: number | null;
      unit_price_cents: number | null;
      line_cost_cents: number | null;
      line_price_cents: number | null;
      notes: string | null;
      before_snapshot: Record<string, unknown> | null;
    };

    try {
      if (d.action === 'add') {
        // Insert new cost line. Only known-required fields; others use DB defaults.
        const { error } = await admin.from('project_cost_lines').insert({
          project_id: projectId,
          budget_category_id: d.budget_category_id,
          category: d.category ?? 'material',
          label: d.label ?? '(unlabeled)',
          qty: d.qty ?? 1,
          unit: d.unit ?? 'item',
          unit_cost_cents: d.unit_cost_cents ?? 0,
          unit_price_cents: d.unit_price_cents ?? 0,
          line_cost_cents: d.line_cost_cents ?? 0,
          line_price_cents: d.line_price_cents ?? 0,
          notes: d.notes,
        });
        if (error) {
          warnings.push({
            code: 'state_diverged',
            message: `Could not add line "${d.label}": ${error.message}`,
            affected_id: d.budget_category_id ?? undefined,
          });
        }
      } else if (d.action === 'modify') {
        if (!d.original_line_id) continue;
        // Try update; if 0 rows affected, the original was deleted.
        const { data: existing } = await admin
          .from('project_cost_lines')
          .select('id')
          .eq('id', d.original_line_id)
          .maybeSingle();
        if (!existing) {
          warnings.push({
            code: 'orphaned_line',
            message: `Original line for "${d.label}" no longer exists — modify skipped.`,
            affected_id: d.original_line_id,
          });
          continue;
        }
        const { error } = await admin
          .from('project_cost_lines')
          .update({
            qty: d.qty,
            unit_cost_cents: d.unit_cost_cents,
            unit_price_cents: d.unit_price_cents,
            line_cost_cents: d.line_cost_cents,
            line_price_cents: d.line_price_cents,
            updated_at: now,
          })
          .eq('id', d.original_line_id);
        if (error) {
          warnings.push({
            code: 'state_diverged',
            message: `Could not modify "${d.label}": ${error.message}`,
            affected_id: d.original_line_id,
          });
        }
      } else if (d.action === 'remove') {
        if (!d.original_line_id) continue;
        const { error } = await admin
          .from('project_cost_lines')
          .delete()
          .eq('id', d.original_line_id);
        if (error) {
          warnings.push({
            code: 'state_diverged',
            message: `Could not remove line: ${error.message}`,
            affected_id: d.original_line_id,
          });
        }
      } else if (d.action === 'modify_envelope') {
        if (!d.budget_category_id || d.line_price_cents == null) continue;
        const { data: existing } = await admin
          .from('project_budget_categories')
          .select('id')
          .eq('id', d.budget_category_id)
          .maybeSingle();
        if (!existing) {
          warnings.push({
            code: 'envelope_missing',
            message: `Budget category for "${d.label}" no longer exists — budget change skipped.`,
            affected_id: d.budget_category_id,
          });
          continue;
        }
        const { error } = await admin
          .from('project_budget_categories')
          .update({
            estimate_cents: d.line_price_cents,
            updated_at: now,
          })
          .eq('id', d.budget_category_id);
        if (error) {
          warnings.push({
            code: 'state_diverged',
            message: `Could not update budget for "${d.label}": ${error.message}`,
            affected_id: d.budget_category_id,
          });
        }
      }
    } catch (e) {
      warnings.push({
        code: 'state_diverged',
        message: `Unexpected error applying ${d.action} on "${d.label}": ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // Mark applied. Even with warnings — partial-apply is recorded so the
  // operator can reconcile.
  await admin
    .from('change_orders')
    .update({
      applied_at: now,
      apply_warnings: warnings,
      updated_at: now,
    })
    .eq('id', changeOrderId);

  return { applied: true, warnings };
}

type ChangeOrderDiffEntry = {
  action: 'add' | 'modify' | 'remove' | 'modify_envelope';
  original_line_id?: string;
  budget_category_id?: string;
  category?: string;
  label?: string;
  qty?: number;
  unit?: string;
  unit_cost_cents?: number;
  unit_price_cents?: number;
  line_cost_cents?: number;
  line_price_cents?: number;
  notes?: string;
  before_snapshot?: Record<string, unknown>;
};

/**
 * Phase-1 line-diff change order. Persists the staged diff to
 * change_order_lines with flow_version=2 on the parent. Does NOT yet
 * apply the diff to project_cost_lines on approval — that's a later
 * phase. See kanban 707d5395 for the full apply-on-approval design.
 */
export async function createChangeOrderV2Action(input: {
  project_id: string;
  title: string;
  description: string;
  reason?: string;
  timeline_impact_days: number;
  cost_impact_cents: number;
  diff: ChangeOrderDiffEntry[];
  category_notes?: { budget_category_id: string; note: string }[];
  /** Per-CO management fee override. NULL = use project default. */
  management_fee_override_rate?: number | null;
  management_fee_override_reason?: string | null;
}): Promise<ChangeOrderActionResult> {
  if (!input.title.trim()) return { ok: false, error: 'Title is required.' };
  if (!input.description.trim()) return { ok: false, error: 'Description is required.' };
  if (input.diff.length === 0) {
    return { ok: false, error: 'At least one staged change is required.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();

  const approvalCode = generateApprovalCode();

  const { data: co, error: coErr } = await supabase
    .from('change_orders')
    .insert({
      project_id: input.project_id,
      tenant_id: tenant.id,
      title: input.title.trim(),
      description: input.description.trim(),
      reason: input.reason?.trim() || null,
      cost_impact_cents: input.cost_impact_cents,
      timeline_impact_days: input.timeline_impact_days,
      affected_buckets: Array.from(
        new Set(
          input.diff
            .map((d) => d.budget_category_id ?? d.before_snapshot?.budget_category_id)
            .filter((id): id is string => typeof id === 'string'),
        ),
      ),
      category_notes: (input.category_notes ?? []).filter((n) => n.note.trim().length > 0),
      flow_version: 2,
      management_fee_override_rate:
        typeof input.management_fee_override_rate === 'number'
          ? input.management_fee_override_rate
          : null,
      management_fee_override_reason: input.management_fee_override_reason?.trim() || null,
      status: 'draft',
      approval_code: approvalCode,
      created_by: tenant.member.id,
    })
    .select('id')
    .single();

  if (coErr || !co) {
    return { ok: false, error: coErr?.message ?? 'Failed to create change order.' };
  }

  const lineRows = input.diff.map((d) => ({
    change_order_id: co.id,
    tenant_id: tenant.id,
    action: d.action,
    original_line_id: d.original_line_id ?? null,
    budget_category_id: d.budget_category_id ?? null,
    category: d.category ?? null,
    label: d.label ?? null,
    qty: d.qty ?? null,
    unit: d.unit ?? null,
    unit_cost_cents: d.unit_cost_cents ?? null,
    unit_price_cents: d.unit_price_cents ?? null,
    line_cost_cents: d.line_cost_cents ?? null,
    line_price_cents: d.line_price_cents ?? null,
    notes: d.notes?.trim() || null,
    before_snapshot: d.before_snapshot ?? null,
  }));

  const { error: linesErr } = await supabase.from('change_order_lines').insert(lineRows);
  if (linesErr) {
    // Roll back the parent CO so we don't end up with an empty diff.
    await supabase.from('change_orders').delete().eq('id', co.id);
    return { ok: false, error: `Failed to save diff: ${linesErr.message}` };
  }

  revalidatePath(`/projects/${input.project_id}`);
  return { ok: true, id: co.id };
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
  category_notes?: { budget_category_id: string; note: string }[];
  /** Per-CO management fee override. NULL = use project default. */
  management_fee_override_rate?: number | null;
  management_fee_override_reason?: string | null;
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
      category_notes: parsed.data.category_notes.filter((n) => n.note.length > 0),
      management_fee_override_rate:
        typeof parsed.data.management_fee_override_rate === 'number'
          ? parsed.data.management_fee_override_rate
          : null,
      management_fee_override_reason: parsed.data.management_fee_override_reason?.trim() || null,
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
    .select(
      'id, project_id, tenant_id, title, status, cost_impact_cents, affected_buckets, flow_version',
    )
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

  // Apply the diff to the underlying baseline.
  // - v2 (line-diff) → apply each row of change_order_lines: add/modify/remove
  //   cost_lines + modify_envelope on budget_categories. The CO IS the
  //   declarative diff; this is its execution.
  // - v1 (legacy cost_breakdown) → keep the existing even-distribute over
  //   affected_buckets so legacy COs continue to behave the same.
  const flowVersion = (coData.flow_version as number | null) ?? 1;
  const applyResult =
    flowVersion === 2 ? await applyV2ChangeOrderDiff(admin, coData.id as string) : null;

  if (flowVersion !== 2) {
    const affectedBuckets = (coData.affected_buckets ?? []) as string[];
    const costDelta = coData.cost_impact_cents as number;
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

  // Portal update
  await admin.from('project_portal_updates').insert({
    project_id: projectId,
    tenant_id: tenantId,
    type: 'system',
    title: 'Change order approved',
    body: `"${coData.title}" approved by ${nameParsed.data.approved_by_name}.${
      applyResult && applyResult.warnings.length > 0
        ? ` (${applyResult.warnings.length} apply warning${applyResult.warnings.length === 1 ? '' : 's'} recorded — operator review)`
        : ''
    }`,
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
