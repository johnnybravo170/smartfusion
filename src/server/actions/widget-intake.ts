'use server';

/**
 * Turn a smart-form widget submission into an `intake_drafts` row that
 * flows through the universal capture pipeline (same dispatcher as
 * email-sourced and voice-sourced leads).
 *
 * Photos arrived on a separate flow: the browser called
 * /api/widget/signed-upload-url to mint per-file PUT URLs, then PUT bytes
 * directly to Supabase. We receive `{ path, mime }` for each completed
 * upload. We trust mime because the signed-upload-url endpoint already
 * validated it against the allow-list before issuing the URL — any other
 * mime claim is harmless metadata noise. Paths still get a tenant-prefix
 * check (anti-tamper) because that gate is what isolates tenants.
 *
 * Does NOT run the classifier — the submit route does that via
 * `parseIntakeDraftAction(draftId)` after this action returns.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { formatWidgetBriefText } from '@/lib/widget/format-brief';

export type WidgetAttachment = {
  path: string;
  mime: string;
};

export type WidgetIntakePayload = {
  tenantId: string;
  name: string;
  phone: string;
  email: string | null;
  description: string;
  attachments: WidgetAttachment[];
};

export type WidgetIntakeResult = { ok: true; draftId: string } | { ok: false; error: string };

function basenameOf(path: string): string {
  const last = path.split('/').pop() ?? '';
  return last || 'photo';
}

export async function createIntakeDraftFromWidgetAction(
  payload: WidgetIntakePayload,
): Promise<WidgetIntakeResult> {
  const admin = createAdminClient();

  // Anti-tamper: every path must live under the authenticated tenant's
  // prefix. The signed-upload-url route mints paths in this shape only;
  // anything else is a forged request.
  const tenantPrefix = `widget/${payload.tenantId}/`;
  for (const att of payload.attachments) {
    if (!att.path.startsWith(tenantPrefix)) {
      return { ok: false, error: `path_not_in_tenant_prefix: ${att.path}` };
    }
  }

  const artifacts = payload.attachments.map((att) => ({
    path: att.path,
    name: basenameOf(att.path),
    mime: att.mime || 'application/octet-stream',
    size: 0,
    kind: null,
    label: null,
  }));

  const { data: draftRow, error: insErr } = await admin
    .from('intake_drafts')
    .insert({
      tenant_id: payload.tenantId,
      status: 'pending',
      source: 'lead_form',
      disposition: 'pending_review',
      customer_name: payload.name,
      pasted_text: formatWidgetBriefText({
        name: payload.name,
        phone: payload.phone,
        email: payload.email,
        description: payload.description,
      }),
      artifacts,
    })
    .select('id')
    .single();

  if (insErr || !draftRow) {
    return {
      ok: false,
      error: `Failed to create intake_draft: ${insErr?.message ?? 'unknown'}`,
    };
  }

  return { ok: true, draftId: draftRow.id as string };
}
