'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type InboundEmailResult = { ok: true; id: string } | { ok: false; error: string };

const billConfirmSchema = z.object({
  emailId: z.string().uuid(),
  projectId: z.string().uuid(),
  vendor: z.string().trim().min(1, 'Vendor is required.'),
  vendorGstNumber: z.string().trim().optional(),
  billDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Bill date must be YYYY-MM-DD.'),
  amountCents: z.coerce.number().int().min(0),
  gstCents: z.coerce.number().int().min(0).default(0),
  description: z.string().trim().optional(),
  budgetCategoryId: z.string().uuid().optional(),
  costLineId: z.string().uuid().optional(),
});

/**
 * Operator-confirmed bill from a forwarded email. Reads the email row for
 * tenant scoping, inserts a `project_bills` row with `status='pending'`
 * (the existing bill lifecycle), and links the inbound_emails row.
 *
 * Trusts the caller's edited fields, not the staged `extracted` JSON —
 * the operator may have corrected vendor / total / category in the dialog.
 */
export async function confirmStagedBillAction(
  input: z.input<typeof billConfirmSchema>,
): Promise<InboundEmailResult> {
  const parsed = billConfirmSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  const data = parsed.data;

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  const { data: email, error: loadErr } = await supabase
    .from('inbound_emails')
    .select('id, tenant_id')
    .eq('id', data.emailId)
    .single();
  if (loadErr || !email) return { ok: false, error: 'Inbound email not found.' };

  const billPreTax = data.amountCents;
  const billGst = data.gstCents;
  const { data: bill, error: billErr } = await supabase
    .from('project_costs')
    .insert({
      tenant_id: tenant.id,
      project_id: data.projectId,
      vendor: data.vendor,
      vendor_gst_number: data.vendorGstNumber || null,
      cost_date: data.billDate,
      description: data.description || null,
      // amount_cents on project_costs is gross; pre_tax preserves the
      // cost-plus markup basis. Inbound-email parses pre-GST + GST
      // separately.
      amount_cents: billPreTax + billGst,
      pre_tax_amount_cents: billPreTax,
      gst_cents: billGst,
      budget_category_id: data.budgetCategoryId || null,
      cost_line_id: data.costLineId || null,
      inbound_email_id: data.emailId,
      source_type: 'vendor_bill',
      payment_status: 'unpaid',
      status: 'active',
    })
    .select('id')
    .single();

  if (billErr || !bill) {
    return { ok: false, error: billErr?.message ?? 'Failed to create bill.' };
  }

  await supabase
    .from('inbound_emails')
    .update({
      project_id: data.projectId,
      status: 'applied',
      applied_bill_id: bill.id,
      processed_at: new Date().toISOString(),
    })
    .eq('id', data.emailId);

  revalidatePath('/inbox/email');
  revalidatePath(`/projects/${data.projectId}`);
  return { ok: true, id: bill.id as string };
}

/**
 * Called by SubQuoteForm immediately after a successful save when the form
 * was opened from a forwarded email. Marks the inbound_emails row applied
 * and links it to the new sub_quote.
 */
export async function linkInboundEmailToSubQuoteAction(input: {
  emailId: string;
  subQuoteId: string;
  projectId: string;
}): Promise<InboundEmailResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('inbound_emails')
    .update({
      project_id: input.projectId,
      status: 'applied',
      applied_sub_quote_id: input.subQuoteId,
      processed_at: new Date().toISOString(),
    })
    .eq('id', input.emailId);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/inbox/email');
  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, id: input.emailId };
}

/** Operator dismisses an email without applying it. */
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

/** Re-run the classifier on an email (operator thinks the AI got it wrong). */
export async function reclassifyInboundEmailAction(emailId: string): Promise<InboundEmailResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
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

  const { processInboundEmail } = await import('@/lib/inbound-email/processor');
  await processInboundEmail(emailId);

  revalidatePath('/inbox/email');
  return { ok: true, id: emailId };
}
