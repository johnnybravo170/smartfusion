'use server';

/**
 * Helper: turn an inbound email (envelope row + Postmark payload) into an
 * `intake_drafts` row that flows through the universal capture pipeline.
 *
 * Per INBOUND_EMAIL_V2_PLAN.md:
 *   - The email body goes into `intake_drafts.pasted_text` (subject +
 *     leading body, formatted as the operator's "forwarding context").
 *   - Each attachment becomes an artifact uploaded to the intake-audio
 *     storage bucket (name is historical; it stages images + PDFs too).
 *   - `source='email'` and `disposition='pending_review'` set on the draft.
 *   - The inbound_emails row gets `intake_draft_id` linked back.
 *
 * Returns the new draft id (or an error). Does NOT run the classifier —
 * that's a separate step in the processor (parseIntakeDraftAction).
 */

import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';

const INTAKE_BUCKET = 'intake-audio';

type PostmarkAttachment = {
  Name: string;
  ContentType: string;
  Content: string;
  ContentLength: number;
};

export type InboundEmailIntakePayload = {
  emailId: string;
  tenantId: string;
  fromAddress: string;
  fromName: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: PostmarkAttachment[];
};

export type InboundEmailIntakeResult = { ok: true; draftId: string } | { ok: false; error: string };

function extOf(contentType: string): string {
  if (contentType === 'application/pdf') return 'pdf';
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/heic' || contentType === 'image/heif') return 'heic';
  if (contentType === 'image/webp') return 'webp';
  if (contentType.startsWith('image/')) return 'jpg';
  return 'bin';
}

/** Format the email envelope into the draft's pasted_text — Henry's "forwarding context". */
function formatPastedText(args: {
  fromAddress: string;
  fromName: string | null;
  subject: string | null;
  bodyText: string | null;
}): string {
  const senderLine = args.fromName ? `${args.fromName} <${args.fromAddress}>` : args.fromAddress;
  const subject = args.subject?.trim() || '(no subject)';
  const body = args.bodyText?.trim() || '';
  return [`Forwarded by: ${senderLine}`, `Subject: ${subject}`, '', body]
    .join('\n')
    .slice(0, 16000); // hard cap so Postmark never blows up the column
}

export async function createIntakeDraftFromEmailAction(
  payload: InboundEmailIntakePayload,
): Promise<InboundEmailIntakeResult> {
  const admin = createAdminClient();

  // Upload each attachment to the intake bucket. Path convention mirrors
  // existing intake usage: {tenant_id}/{uuid}.{ext}.
  const artifacts: Array<{
    path: string;
    name: string;
    mime: string;
    size: number;
    kind: null;
    label: null;
  }> = [];
  const uploadedPaths: string[] = []; // for cleanup if the insert fails

  for (const att of payload.attachments) {
    if (!att.Content) continue; // base64 missing — skip
    const ext = extOf(att.ContentType || 'application/octet-stream');
    const path = `${payload.tenantId}/${randomUUID()}.${ext}`;
    const buf = Buffer.from(att.Content, 'base64');
    const { error: upErr } = await admin.storage.from(INTAKE_BUCKET).upload(path, buf, {
      contentType: att.ContentType || 'application/octet-stream',
      upsert: false,
    });
    if (upErr) {
      // Best-effort cleanup of anything we uploaded so we don't leak.
      if (uploadedPaths.length > 0) {
        await admin.storage.from(INTAKE_BUCKET).remove(uploadedPaths);
      }
      return { ok: false, error: `Attachment upload failed: ${upErr.message}` };
    }
    uploadedPaths.push(path);
    artifacts.push({
      path,
      name: att.Name || 'attachment',
      mime: att.ContentType || 'application/octet-stream',
      size: att.ContentLength || buf.byteLength,
      kind: null, // classifier will fill this in
      label: null,
    });
  }

  // Insert the draft.
  const { data: draftRow, error: insErr } = await admin
    .from('intake_drafts')
    .insert({
      tenant_id: payload.tenantId,
      status: 'pending',
      source: 'email',
      disposition: 'pending_review',
      customer_name: null,
      pasted_text: formatPastedText({
        fromAddress: payload.fromAddress,
        fromName: payload.fromName,
        subject: payload.subject,
        bodyText: payload.bodyText,
      }),
      artifacts,
    })
    .select('id')
    .single();

  if (insErr || !draftRow) {
    if (uploadedPaths.length > 0) {
      await admin.storage.from(INTAKE_BUCKET).remove(uploadedPaths);
    }
    return {
      ok: false,
      error: `Failed to create intake_draft: ${insErr?.message ?? 'unknown'}`,
    };
  }

  const draftId = draftRow.id as string;

  // Link the email envelope row back to its draft.
  const { error: linkErr } = await admin
    .from('inbound_emails')
    .update({ intake_draft_id: draftId })
    .eq('id', payload.emailId);
  if (linkErr) {
    // Don't fail the call — the draft exists and is parseable; linkage is a
    // diagnostic affordance. Surface to logs.
    console.error('[inbound-email-intake] failed to link draft to email', {
      emailId: payload.emailId,
      draftId,
      error: linkErr.message,
    });
  }

  return { ok: true, draftId };
}
