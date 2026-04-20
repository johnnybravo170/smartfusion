/**
 * Process an inbound email row: classify with Gemini, auto-apply at
 * high confidence, or flag for manual review.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { type ClassifierResult, classifyInboundEmail, type ProjectContext } from './classifier';

const AUTO_APPLY_THRESHOLD = 0.8;

export async function processInboundEmail(emailId: string): Promise<void> {
  const admin = createAdminClient();

  const { data: email, error: loadErr } = await admin
    .from('inbound_emails')
    .select('*')
    .eq('id', emailId)
    .single();

  if (loadErr || !email) throw new Error(`Inbound email not found: ${emailId}`);
  if (!email.tenant_id) {
    await admin
      .from('inbound_emails')
      .update({
        status: 'error',
        error_message: 'No tenant resolved from address',
        processed_at: new Date().toISOString(),
      })
      .eq('id', emailId);
    return;
  }

  await admin.from('inbound_emails').update({ status: 'processing' }).eq('id', emailId);

  // Load active projects for this tenant.
  const { data: projectsRaw } = await admin
    .from('projects')
    .select('id, name, description, customers:customer_id (name)')
    .eq('tenant_id', email.tenant_id)
    .is('deleted_at', null)
    .in('status', ['planning', 'in_progress']);

  const projects: ProjectContext[] = (projectsRaw ?? []).map((p) => {
    const customerRaw = Array.isArray(p.customers) ? p.customers[0] : p.customers;
    return {
      id: p.id as string,
      name: p.name as string,
      description: (p.description as string | null) ?? null,
      customer_name:
        customerRaw && typeof customerRaw === 'object' && 'name' in customerRaw
          ? (customerRaw as { name: string }).name
          : null,
    };
  });

  const attachments = (
    (email.attachments as { filename: string; contentType: string; base64: string }[]) ?? []
  ).slice(0, 5);

  let result: ClassifierResult;
  try {
    result = await classifyInboundEmail(
      {
        from: email.from_address as string,
        from_name: (email.from_name as string | null) ?? null,
        subject: (email.subject as string | null) ?? '',
        body_text: (email.body_text as string | null) ?? '',
        attachments,
      },
      projects,
    );
  } catch (err) {
    await admin
      .from('inbound_emails')
      .update({
        status: 'error',
        error_message: err instanceof Error ? err.message : String(err),
        processed_at: new Date().toISOString(),
      })
      .eq('id', emailId);
    return;
  }

  const matchedProjectId = result.project_match?.id ?? null;
  const matchConfidence = result.project_match?.confidence ?? null;

  const canAutoApply =
    (result.classification === 'sub_quote' || result.classification === 'vendor_bill') &&
    result.confidence >= AUTO_APPLY_THRESHOLD &&
    matchedProjectId !== null &&
    (matchConfidence ?? 0) >= AUTO_APPLY_THRESHOLD;

  if (canAutoApply && result.extracted) {
    try {
      if (result.classification === 'vendor_bill') {
        const bill = result.extracted as {
          vendor: string;
          bill_date: string;
          description?: string;
          amount_cents: number;
          cost_code?: string;
        };
        const { data: created, error: billErr } = await admin
          .from('project_bills')
          .insert({
            tenant_id: email.tenant_id,
            project_id: matchedProjectId,
            vendor: bill.vendor,
            bill_date: bill.bill_date,
            description: bill.description ?? null,
            amount_cents: bill.amount_cents,
            cost_code: bill.cost_code ?? null,
            inbound_email_id: emailId,
          })
          .select('id')
          .single();
        if (billErr || !created) throw new Error(billErr?.message ?? 'Failed to create bill');

        await admin
          .from('inbound_emails')
          .update({
            classification: result.classification,
            confidence: result.confidence,
            extracted: result.extracted,
            classifier_notes: result.notes,
            project_id: matchedProjectId,
            project_match_confidence: matchConfidence,
            status: 'auto_applied',
            applied_bill_id: created.id,
            processed_at: new Date().toISOString(),
          })
          .eq('id', emailId);
        return;
      }

      if (result.classification === 'sub_quote') {
        const quote = result.extracted as {
          vendor: string;
          items: { description: string; qty: number; unit: string; unit_cost_cents: number }[];
          total_cents: number;
          notes?: string;
        };
        const lineRows = quote.items.map((item, idx) => ({
          project_id: matchedProjectId,
          category: 'sub',
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

        const { data: createdLines, error: linesErr } = await admin
          .from('project_cost_lines')
          .insert(lineRows)
          .select('id');
        if (linesErr) throw new Error(linesErr.message);

        await admin
          .from('inbound_emails')
          .update({
            classification: result.classification,
            confidence: result.confidence,
            extracted: result.extracted,
            classifier_notes: result.notes,
            project_id: matchedProjectId,
            project_match_confidence: matchConfidence,
            status: 'auto_applied',
            applied_cost_line_ids: (createdLines ?? []).map((r) => r.id as string),
            processed_at: new Date().toISOString(),
          })
          .eq('id', emailId);
        return;
      }
    } catch (err) {
      await admin
        .from('inbound_emails')
        .update({
          classification: result.classification,
          confidence: result.confidence,
          extracted: result.extracted,
          classifier_notes: result.notes,
          project_id: matchedProjectId,
          project_match_confidence: matchConfidence,
          status: 'error',
          error_message: err instanceof Error ? err.message : String(err),
          processed_at: new Date().toISOString(),
        })
        .eq('id', emailId);
      return;
    }
  }

  // Not auto-applied — route to review inbox.
  const status = result.classification === 'other' ? 'rejected' : 'needs_review';
  await admin
    .from('inbound_emails')
    .update({
      classification: result.classification,
      confidence: result.confidence,
      extracted: result.extracted,
      classifier_notes: result.notes,
      project_id: matchedProjectId,
      project_match_confidence: matchConfidence,
      status,
      processed_at: new Date().toISOString(),
    })
    .eq('id', emailId);
}
