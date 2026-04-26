'use server';

/**
 * Project Pulse — server actions.
 *
 * Flow:
 *   1. Owner clicks "Update Client" on a job → draftPulseAction()
 *      writes (or returns the existing unsent draft) and returns its id.
 *   2. Owner edits inline → editPulseDraftAction().
 *   3. Owner clicks "Approve & Send" → approvePulseAction() generates a
 *      public_code, marks approved, fires SMS+email.
 */

import crypto from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { getEmailBrandingForTenant } from '@/lib/email/branding';
import { sendEmail } from '@/lib/email/send';
import { pulseUpdateEmailHtml } from '@/lib/email/templates/pulse-update';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { sendSms } from '@/lib/twilio/client';
import { draftPulseUpdate, type PulsePayload } from '@/server/ai/pulse';

export type PulseActionResult =
  | { ok: true; id: string; code?: string }
  | { ok: false; error: string };

function generatePublicCode(): string {
  return crypto.randomBytes(9).toString('base64url').slice(0, 12);
}

/**
 * Either returns the most recent unsent draft for this job (so refreshes
 * don't keep stacking up draft rows) or creates a new one with Henry's
 * draft body.
 */
export async function draftPulseAction(jobId: string): Promise<PulseActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const admin = createAdminClient();

  // Reuse the most recent unsent draft for the same job.
  const { data: existing } = await admin
    .from('pulse_updates')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('job_id', jobId)
    .is('approved_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing?.id) {
    return { ok: true, id: existing.id as string };
  }

  let draft: Awaited<ReturnType<typeof draftPulseUpdate>>;
  try {
    draft = await draftPulseUpdate(jobId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Draft failed.' };
  }

  const { data: row, error: insErr } = await admin
    .from('pulse_updates')
    .insert({
      tenant_id: tenant.id,
      job_id: jobId,
      public_code: generatePublicCode(),
      title: draft.title,
      body_md: draft.body_md,
      payload: draft.payload,
      drafted_by: 'henry',
    })
    .select('id')
    .single();

  if (insErr || !row) {
    return { ok: false, error: insErr?.message ?? 'Insert failed.' };
  }

  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, id: row.id as string };
}

export async function editPulseDraftAction(input: {
  updateId: string;
  body_md: string;
  payload?: PulsePayload;
}): Promise<PulseActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const body = input.body_md.trim();
  if (!body) return { ok: false, error: 'Body cannot be empty.' };

  const admin = createAdminClient();
  const fields: Record<string, unknown> = { body_md: body, drafted_by: 'owner' };
  if (input.payload) fields.payload = input.payload;

  const { error } = await admin
    .from('pulse_updates')
    .update(fields)
    .eq('id', input.updateId)
    .eq('tenant_id', tenant.id)
    .is('approved_at', null);

  if (error) return { ok: false, error: error.message };
  return { ok: true, id: input.updateId };
}

/**
 * Approve & send. Stamps approved_at + sent_at, fires email + SMS.
 */
export async function approvePulseAction(updateId: string): Promise<PulseActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const admin = createAdminClient();

  const { data: row, error: rowErr } = await admin
    .from('pulse_updates')
    .select('id, job_id, title, body_md, public_code, approved_at')
    .eq('id', updateId)
    .eq('tenant_id', tenant.id)
    .maybeSingle();

  if (rowErr || !row) return { ok: false, error: 'Update not found.' };
  if (row.approved_at) return { ok: false, error: 'Already approved.' };

  // Fetch the customer for delivery.
  const { data: jobRow } = await admin
    .from('jobs')
    .select('customers:customer_id (name, email, phone)')
    .eq('id', row.job_id)
    .maybeSingle();

  const customerRaw =
    (jobRow?.customers as
      | { name?: string; email?: string | null; phone?: string | null }
      | { name?: string; email?: string | null; phone?: string | null }[]
      | null) ?? null;
  const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
  const email = customer?.email ?? null;
  const phone = customer?.phone ?? null;

  if (!email && !phone) {
    return {
      ok: false,
      error: 'Customer has no email or phone on file. Add one before sending.',
    };
  }

  const code = (row.public_code as string) || generatePublicCode();
  const publicUrl = `https://heyhenry.io/pulse/${code}`;
  const projectName = (row.title as string).replace(/^Your Project — /, '');

  // Send email
  let sentEmailTo: string | null = null;
  if (email) {
    const branding = await getEmailBrandingForTenant(tenant.id);
    const html = pulseUpdateEmailHtml({
      businessName: branding.businessName,
      logoUrl: branding.logoUrl,
      projectName,
      bodyText: row.body_md as string,
      publicUrl,
    });
    const res = await sendEmail({
      tenantId: tenant.id,
      to: email,
      subject: `Update on your ${projectName} project`,
      html,
      caslCategory: 'transactional',
      relatedType: 'pulse',
      relatedId: row.job_id as string,
      caslEvidence: { kind: 'pulse_update', jobId: row.job_id, updateId },
    });
    if (res.ok) sentEmailTo = email;
  }

  // Send SMS
  let sentSmsTo: string | null = null;
  if (phone) {
    const res = await sendSms({
      tenantId: tenant.id,
      to: phone,
      body: `Update on your ${projectName} project: ${publicUrl}`,
      relatedType: 'job',
      relatedId: row.job_id as string,
      caslCategory: 'transactional',
      caslEvidence: { kind: 'pulse_update', jobId: row.job_id, updateId },
    });
    if (res.ok) sentSmsTo = phone;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const approverId = user?.id ?? null;

  const now = new Date().toISOString();
  const { error: updErr } = await admin
    .from('pulse_updates')
    .update({
      approved_at: now,
      approved_by: approverId,
      sent_at: now,
      sent_email_to: sentEmailTo,
      sent_sms_to: sentSmsTo,
      public_code: code,
    })
    .eq('id', updateId);

  if (updErr) return { ok: false, error: updErr.message };

  revalidatePath(`/jobs/${row.job_id}`);
  return { ok: true, id: updateId, code };
}
