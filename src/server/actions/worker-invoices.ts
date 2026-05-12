'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant, requireWorker } from '@/lib/auth/helpers';
import { safeMirrorExpenses } from '@/lib/db/project-costs-shim';
import { previewUnbilledForWorker } from '@/lib/db/queries/worker-invoices';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';
import { createAdminClient } from '@/lib/supabase/admin';

export type InvoiceResult = { ok: true; id: string } | { ok: false; error: string };
export type PlainResult = { ok: true } | { ok: false; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const submitSchema = z.object({
  project_id: z.string().uuid().nullable().optional(),
  period_start: z.string().regex(DATE_RE),
  period_end: z.string().regex(DATE_RE),
  tax_rate: z.coerce.number().min(0).max(1),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});

export async function submitWorkerInvoiceAction(input: {
  project_id?: string | null;
  period_start: string;
  period_end: string;
  tax_rate: number;
  notes?: string;
}): Promise<InvoiceResult> {
  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? 'Invalid input.' };
  }
  if (parsed.data.period_end < parsed.data.period_start) {
    return { ok: false, error: 'End date is before start date.' };
  }

  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);

  const admin = createAdminClient();

  // Capability check.
  const { data: tenantRow } = await admin
    .from('tenants')
    .select('workers_can_invoice_default')
    .eq('id', tenant.id)
    .maybeSingle();
  const canInvoice = profile.can_invoice ?? tenantRow?.workers_can_invoice_default ?? false;
  if (!canInvoice) {
    return { ok: false, error: 'Invoicing is not enabled for your account.' };
  }

  // Gather unbilled rows in range.
  const { time, expenses } = await previewUnbilledForWorker({
    tenantId: tenant.id,
    workerProfileId: profile.id,
    projectId: parsed.data.project_id ?? null,
    fromDate: parsed.data.period_start,
    toDate: parsed.data.period_end,
  });

  if (time.length === 0 && expenses.length === 0) {
    return { ok: false, error: 'Nothing to invoice in that period.' };
  }

  const timeTotal = time.reduce((s, r) => s + r.amount_cents, 0);
  const expenseTotal = expenses.reduce((s, r) => s + r.amount_cents, 0);
  const subtotal = timeTotal + expenseTotal;
  const taxCents = Math.round(subtotal * parsed.data.tax_rate);
  const total = subtotal + taxCents;

  const { data: inserted, error: insErr } = await admin
    .from('worker_invoices')
    .insert({
      tenant_id: tenant.id,
      worker_profile_id: profile.id,
      project_id: parsed.data.project_id ?? null,
      status: 'submitted',
      period_start: parsed.data.period_start,
      period_end: parsed.data.period_end,
      subtotal_cents: subtotal,
      tax_rate: parsed.data.tax_rate,
      tax_cents: taxCents,
      total_cents: total,
      notes: parsed.data.notes?.trim() || null,
      submitted_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (insErr || !inserted) {
    return { ok: false, error: insErr?.message ?? 'Failed to create invoice.' };
  }

  const invoiceId = inserted.id as string;

  // Stamp underlying rows. If either stamp fails, delete the invoice.
  const timeIds = time.map((r) => r.id);
  const expIds = expenses.map((r) => r.id);
  if (timeIds.length > 0) {
    const { error } = await admin
      .from('time_entries')
      .update({ worker_invoice_id: invoiceId })
      .in('id', timeIds)
      .is('worker_invoice_id', null);
    if (error) {
      await admin.from('worker_invoices').delete().eq('id', invoiceId);
      return { ok: false, error: error.message };
    }
  }
  if (expIds.length > 0) {
    const { error } = await admin
      .from('expenses')
      .update({ worker_invoice_id: invoiceId })
      .in('id', expIds)
      .is('worker_invoice_id', null);
    if (error) {
      // Roll back the time stamps.
      if (timeIds.length > 0) {
        await admin
          .from('time_entries')
          .update({ worker_invoice_id: null })
          .in('id', timeIds)
          .eq('worker_invoice_id', invoiceId);
      }
      await admin.from('worker_invoices').delete().eq('id', invoiceId);
      return { ok: false, error: error.message };
    }
    await safeMirrorExpenses(admin, expIds);
  }

  revalidatePath('/w/invoices');
  revalidatePath('/w');
  if (parsed.data.project_id) revalidatePath(`/projects/${parsed.data.project_id}`);
  return { ok: true, id: invoiceId };
}

export async function deleteWorkerInvoiceAction(id: string): Promise<PlainResult> {
  if (!id) return { ok: false, error: 'Missing id.' };
  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);

  const admin = createAdminClient();
  const { data: row } = await admin
    .from('worker_invoices')
    .select('id, worker_profile_id, status, project_id')
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .maybeSingle();
  if (!row || row.worker_profile_id !== profile.id) {
    return { ok: false, error: 'Invoice not found.' };
  }
  if (row.status !== 'submitted' && row.status !== 'rejected') {
    return { ok: false, error: 'Only submitted or rejected invoices can be withdrawn.' };
  }

  // Clear stamps first so rows can be invoiced again.
  await admin.from('time_entries').update({ worker_invoice_id: null }).eq('worker_invoice_id', id);
  const { data: clearedExpenses } = await admin
    .from('expenses')
    .update({ worker_invoice_id: null })
    .eq('worker_invoice_id', id)
    .select('id');
  await safeMirrorExpenses(
    admin,
    (clearedExpenses ?? []).map((r) => r.id as string),
  );

  const { error } = await admin.from('worker_invoices').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/w/invoices');
  if (row.project_id) revalidatePath(`/projects/${row.project_id as string}`);
  return { ok: true };
}

// ---------- Owner actions ----------

async function requireOwnerOrAdmin() {
  const tenant = await getCurrentTenant();
  if (!tenant) throw new Error('Not signed in.');
  if (tenant.member.role !== 'owner' && tenant.member.role !== 'admin') {
    throw new Error('Only owners and admins can act on worker invoices.');
  }
  return tenant;
}

const rejectSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().trim().max(500).optional().default(''),
});

export async function approveWorkerInvoiceAction(id: string): Promise<PlainResult> {
  let tenant: Awaited<ReturnType<typeof getCurrentTenant>>;
  try {
    tenant = await requireOwnerOrAdmin();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Forbidden.' };
  }
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const admin = createAdminClient();
  const { data: row } = await admin
    .from('worker_invoices')
    .select('id, status, project_id')
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .maybeSingle();
  if (!row) return { ok: false, error: 'Invoice not found.' };
  if (row.status !== 'submitted')
    return { ok: false, error: 'Only submitted invoices can be approved.' };

  const { error } = await admin
    .from('worker_invoices')
    .update({
      status: 'approved',
      approved_at: new Date().toISOString(),
      rejection_reason: null,
    })
    .eq('id', id)
    .eq('tenant_id', tenant.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/w/invoices');
  if (row.project_id) revalidatePath(`/projects/${row.project_id as string}`);
  return { ok: true };
}

export async function rejectWorkerInvoiceAction(input: {
  id: string;
  reason: string;
}): Promise<PlainResult> {
  const parsed = rejectSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };

  let tenant: Awaited<ReturnType<typeof getCurrentTenant>>;
  try {
    tenant = await requireOwnerOrAdmin();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Forbidden.' };
  }
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const admin = createAdminClient();
  const { data: row } = await admin
    .from('worker_invoices')
    .select('id, status, project_id')
    .eq('id', parsed.data.id)
    .eq('tenant_id', tenant.id)
    .maybeSingle();
  if (!row) return { ok: false, error: 'Invoice not found.' };
  if (row.status !== 'submitted')
    return { ok: false, error: 'Only submitted invoices can be rejected.' };

  // Clear stamps so the worker can fix and resubmit.
  await admin
    .from('time_entries')
    .update({ worker_invoice_id: null })
    .eq('worker_invoice_id', parsed.data.id);
  const { data: rejectClearedExpenses } = await admin
    .from('expenses')
    .update({ worker_invoice_id: null })
    .eq('worker_invoice_id', parsed.data.id)
    .select('id');
  await safeMirrorExpenses(
    admin,
    (rejectClearedExpenses ?? []).map((r) => r.id as string),
  );

  const { error } = await admin
    .from('worker_invoices')
    .update({
      status: 'rejected',
      rejection_reason: parsed.data.reason || 'No reason provided.',
    })
    .eq('id', parsed.data.id)
    .eq('tenant_id', tenant.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/w/invoices');
  if (row.project_id) revalidatePath(`/projects/${row.project_id as string}`);
  return { ok: true };
}

export async function markWorkerInvoicePaidAction(id: string): Promise<PlainResult> {
  let tenant: Awaited<ReturnType<typeof getCurrentTenant>>;
  try {
    tenant = await requireOwnerOrAdmin();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Forbidden.' };
  }
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const admin = createAdminClient();
  const { data: row } = await admin
    .from('worker_invoices')
    .select('id, status, project_id')
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .maybeSingle();
  if (!row) return { ok: false, error: 'Invoice not found.' };
  if (row.status !== 'approved') return { ok: false, error: 'Approve the invoice first.' };

  const { error } = await admin
    .from('worker_invoices')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', id)
    .eq('tenant_id', tenant.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/w/invoices');
  if (row.project_id) revalidatePath(`/projects/${row.project_id as string}`);
  return { ok: true };
}
