'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import type { ExtractedSubQuote, ExtractedVendorBill } from '@/lib/inbound-email/classifier';
import { createClient } from '@/lib/supabase/server';

export type InboundEmailResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * Accept the classifier's suggestion and apply it to the selected project.
 * Caller may override the target project (if classifier got it wrong).
 */
export async function applyInboundEmailAction(input: {
  emailId: string;
  projectId: string;
}): Promise<InboundEmailResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  const { data: email, error: loadErr } = await supabase
    .from('inbound_emails')
    .select('id, classification, extracted, applied_bill_id, applied_cost_line_ids')
    .eq('id', input.emailId)
    .single();

  if (loadErr || !email) return { ok: false, error: 'Inbound email not found.' };
  if (!email.extracted) return { ok: false, error: 'No extracted data to apply.' };

  if (email.classification === 'vendor_bill') {
    const bill = email.extracted as unknown as ExtractedVendorBill;
    const { data: created, error } = await supabase
      .from('project_bills')
      .insert({
        tenant_id: tenant.id,
        project_id: input.projectId,
        vendor: bill.vendor,
        bill_date: bill.bill_date,
        description: bill.description ?? null,
        amount_cents: bill.amount_cents,
        cost_code: bill.cost_code ?? null,
        inbound_email_id: email.id,
      })
      .select('id')
      .single();
    if (error || !created) return { ok: false, error: error?.message ?? 'Failed to create bill.' };

    await supabase
      .from('inbound_emails')
      .update({
        project_id: input.projectId,
        status: 'applied',
        applied_bill_id: created.id,
        processed_at: new Date().toISOString(),
      })
      .eq('id', email.id);
  } else if (email.classification === 'sub_quote') {
    const quote = email.extracted as unknown as ExtractedSubQuote;
    const rows = quote.items.map((item, idx) => ({
      project_id: input.projectId,
      category: 'sub' as const,
      label: `${quote.vendor}: ${item.description}`,
      qty: item.qty,
      unit: item.unit,
      unit_cost_cents: item.unit_cost_cents,
      unit_price_cents: item.unit_cost_cents,
      markup_pct: 0,
      line_cost_cents: Math.round(item.qty * item.unit_cost_cents),
      line_price_cents: Math.round(item.qty * item.unit_cost_cents),
      sort_order: idx,
      notes: quote.notes ?? null,
    }));
    const { data: created, error } = await supabase
      .from('project_cost_lines')
      .insert(rows)
      .select('id');
    if (error) return { ok: false, error: error.message };

    await supabase
      .from('inbound_emails')
      .update({
        project_id: input.projectId,
        status: 'applied',
        applied_cost_line_ids: (created ?? []).map((r) => r.id as string),
        processed_at: new Date().toISOString(),
      })
      .eq('id', email.id);
  } else {
    return { ok: false, error: 'Only sub_quote and vendor_bill can be applied.' };
  }

  revalidatePath('/inbox/email');
  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, id: email.id };
}

/** Reject/dismiss an email without applying it. */
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

/** Move an already-applied bill or cost line to a different project. */
export async function reassignInboundEmailAction(input: {
  emailId: string;
  newProjectId: string;
}): Promise<InboundEmailResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  const { data: email, error: loadErr } = await supabase
    .from('inbound_emails')
    .select('id, project_id, applied_bill_id, applied_cost_line_ids')
    .eq('id', input.emailId)
    .single();

  if (loadErr || !email) return { ok: false, error: 'Inbound email not found.' };

  const oldProjectId = email.project_id as string | null;

  // Move the bill, if any.
  if (email.applied_bill_id) {
    const { error } = await supabase
      .from('project_bills')
      .update({ project_id: input.newProjectId, updated_at: new Date().toISOString() })
      .eq('id', email.applied_bill_id);
    if (error) return { ok: false, error: error.message };
  }

  // Move the cost lines, if any.
  const costLineIds = (email.applied_cost_line_ids as string[] | null) ?? [];
  if (costLineIds.length > 0) {
    const { error } = await supabase
      .from('project_cost_lines')
      .update({ project_id: input.newProjectId, updated_at: new Date().toISOString() })
      .in('id', costLineIds);
    if (error) return { ok: false, error: error.message };
  }

  const { error: updErr } = await supabase
    .from('inbound_emails')
    .update({ project_id: input.newProjectId, updated_at: new Date().toISOString() })
    .eq('id', input.emailId);
  if (updErr) return { ok: false, error: updErr.message };

  revalidatePath('/inbox/email');
  if (oldProjectId) revalidatePath(`/projects/${oldProjectId}`);
  revalidatePath(`/projects/${input.newProjectId}`);
  return { ok: true, id: input.emailId };
}

/** Re-run the Gemini classifier on an email (if the user thinks it got it wrong). */
export async function reclassifyInboundEmailAction(emailId: string): Promise<InboundEmailResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  // Reset status so the processor picks it up fresh.
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

  // Kick off the processor inline. The processor uses the admin client itself.
  const { processInboundEmail } = await import('@/lib/inbound-email/processor');
  await processInboundEmail(emailId);

  revalidatePath('/inbox/email');
  return { ok: true, id: emailId };
}
