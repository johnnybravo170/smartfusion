/**
 * Process an inbound email row by routing it into the universal intake
 * pipeline (V2 FLIP). The narrow V1 classifier+stage path is gone —
 * `intake_drafts` is the unit of work; `inbound_emails` is now just the
 * envelope row (sender / subject / headers) linked to the draft via
 * `intake_draft_id`.
 *
 * Sequence:
 *   1. Build the InboundEmailIntakePayload from the envelope row.
 *   2. createIntakeDraftFromEmailAction → uploads attachments to the
 *      intake-audio bucket + inserts the intake_drafts row + links
 *      inbound_emails.intake_draft_id.
 *   3. parseIntakeDraftAction → runs the universal classifier
 *      (artifact-level kinds + per-row label) against the draft.
 *   4. Stamp inbound_emails.status='routed_to_intake'.
 *
 * Failure modes set inbound_emails.status='bounced' or the draft's own
 * status='failed'; the inbox surface shows the failed draft in the
 * 'error' disposition.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { createIntakeDraftFromEmailAction } from '@/server/actions/inbound-email-intake';
import { parseIntakeDraftAction } from '@/server/actions/intake';

type StoredAttachment = {
  filename?: string;
  contentType?: string;
  base64?: string;
  /** The webhook persists `size` (not `contentLength`); some legacy rows
   * may use the older field name — read both. */
  size?: number;
  contentLength?: number;
};

export async function processInboundEmail(emailId: string): Promise<{ draftId: string | null }> {
  const admin = createAdminClient();

  const { data: email, error: loadErr } = await admin
    .from('inbound_emails')
    .select(
      'id, tenant_id, from_address, from_name, subject, body_text, body_html, attachments, intake_draft_id, status',
    )
    .eq('id', emailId)
    .single();

  if (loadErr || !email) throw new Error(`Inbound email not found: ${emailId}`);
  if (!email.tenant_id) {
    await admin
      .from('inbound_emails')
      .update({ status: 'bounced', processed_at: new Date().toISOString() })
      .eq('id', emailId);
    return { draftId: null };
  }

  // Idempotency: if we already have a draft, just re-parse it. This is
  // how reclassify works (parseIntakeDraftAction takes a draftId), but
  // also catches a duplicate webhook delivery.
  let draftId = (email.intake_draft_id as string | null) ?? null;

  if (!draftId) {
    const attachments = ((email.attachments as StoredAttachment[] | null) ?? [])
      .filter((a) => a.base64)
      .slice(0, 12)
      .map((a) => ({
        Name: a.filename ?? 'attachment',
        ContentType: a.contentType ?? 'application/octet-stream',
        Content: a.base64 ?? '',
        ContentLength: a.contentLength ?? a.size ?? 0,
      }));

    const draftRes = await createIntakeDraftFromEmailAction({
      emailId: emailId,
      tenantId: email.tenant_id as string,
      fromAddress: email.from_address as string,
      fromName: (email.from_name as string | null) ?? null,
      subject: (email.subject as string | null) ?? null,
      bodyText: (email.body_text as string | null) ?? null,
      bodyHtml: (email.body_html as string | null) ?? null,
      attachments,
    });

    if (!draftRes.ok) {
      await admin
        .from('inbound_emails')
        .update({
          status: 'bounced',
          error_message: `Intake draft create failed: ${draftRes.error}`.slice(0, 500),
          processed_at: new Date().toISOString(),
        })
        .eq('id', emailId);
      return { draftId: null };
    }
    draftId = draftRes.draftId;
  }

  // Mark routed (envelope-level state). Done before the parse so the inbox
  // shows the row immediately even if parsing is slow.
  await admin
    .from('inbound_emails')
    .update({ status: 'routed_to_intake', processed_at: new Date().toISOString() })
    .eq('id', emailId);

  // Run the universal classifier. Failures are captured on the draft row
  // (status='failed', error_message); we don't bounce the envelope for a
  // parse failure — the operator can reclassify from the inbox.
  await parseIntakeDraftAction(draftId).catch((err) => {
    console.error('[processor] parseIntakeDraftAction failed', { draftId, error: err });
  });

  return { draftId };
}
