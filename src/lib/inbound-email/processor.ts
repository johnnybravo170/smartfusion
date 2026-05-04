/**
 * Process an inbound email row: classify with the AI gateway, match to a
 * project if possible, and stage for operator confirmation.
 *
 * No auto-apply — every staged item must be confirmed by the operator
 * via the inbox UI before anything is written to project_bills or
 * project_sub_quotes. The classifier's `extracted` JSON sits on the
 * inbound_emails row until the operator reviews it.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { type ClassifierResult, classifyInboundEmail, type ProjectContext } from './classifier';

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
        error_message: 'No tenant resolved from sender',
        processed_at: new Date().toISOString(),
      })
      .eq('id', emailId);
    return;
  }

  await admin.from('inbound_emails').update({ status: 'processing' }).eq('id', emailId);

  const { data: projectsRaw } = await admin
    .from('projects')
    .select('id, name, description, customers:customer_id (name)')
    .eq('tenant_id', email.tenant_id)
    .is('deleted_at', null)
    .in('lifecycle_stage', ['planning', 'awaiting_approval', 'active']);

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
      email.tenant_id as string,
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

  // No auto-apply path — stage everything for operator confirmation.
  // 'other' classifications get auto-rejected; the rest go to needs_review
  // regardless of confidence. The operator decides.
  const status = result.classification === 'other' ? 'rejected' : 'needs_review';

  await admin
    .from('inbound_emails')
    .update({
      classification: result.classification,
      confidence: result.confidence,
      extracted: result.extracted,
      classifier_notes: result.notes,
      project_id: result.project_match?.id ?? null,
      project_match_confidence: result.project_match?.confidence ?? null,
      status,
      processed_at: new Date().toISOString(),
    })
    .eq('id', emailId);
}
