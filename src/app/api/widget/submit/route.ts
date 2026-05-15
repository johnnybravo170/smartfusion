/**
 * Submit endpoint for the smart-form widget. Public-facing, no session.
 *
 * Flow:
 *   1. Token + origin gate via `authenticateWidgetRequest`.
 *   2. Per-IP and per-token rate limits on submission.
 *   3. Validate the JSON body (name, phone required; email optional;
 *      description required; attachedPaths array of widget/<tenant>/...).
 *   4. Insert the `intake_drafts` row (source='lead_form').
 *   5. Trigger the universal classifier — `parseIntakeDraftAction(draftId)`.
 *      Failures are captured on the draft itself; we don't bounce the
 *      submission for a parse error.
 *   6. Notify the contractor via email. `sendEmail` handles demo-tenant
 *      suppression at its chokepoint; do not bypass.
 *
 * Anti-tamper: tenant id is always resolved from the token, never trusted
 * from the request body. Attached photo paths must live under the
 * authenticated tenant's prefix (enforced in `createIntakeDraftFromWidgetAction`).
 */

import { type NextRequest, NextResponse } from 'next/server';
import { sendEmail } from '@/lib/email/send';
import { widgetLeadNotificationHtml } from '@/lib/email/templates/widget-lead-notification';
import { callerIp, checkRateLimit, describeRetryAfter } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticateWidgetRequest } from '@/lib/widget/auth';
import { widgetCorsHeaders } from '@/lib/widget/cors';
import { parseIntakeDraftAction } from '@/server/actions/intake';
import { createIntakeDraftFromWidgetAction } from '@/server/actions/widget-intake';

const MAX_NAME = 200;
const MAX_PHONE = 40;
const MAX_EMAIL = 320;
const MIN_DESCRIPTION = 1;
const MAX_DESCRIPTION = 5000;
const MAX_PHOTOS = 10;

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: widgetCorsHeaders(req.headers.get('origin')),
  });
}

type SubmitBody = {
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  description?: unknown;
  attachments?: unknown;
};

const ALLOWED_ATTACHMENT_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
]);

function asString(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  const cors = widgetCorsHeaders(origin);

  const auth = await authenticateWidgetRequest({
    authHeader: req.headers.get('authorization'),
    origin,
  });
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error },
      { status: auth.status, headers: cors },
    );
  }
  const { config } = auth;

  const ip = await callerIp();
  const ipLimit = await checkRateLimit(`widget:submit:ip:${ip}`, {
    limit: 5,
    windowMs: 60 * 60_000,
  });
  if (!ipLimit.ok) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited', retryAfter: describeRetryAfter(ipLimit.retryAfterMs) },
      { status: 429, headers: cors },
    );
  }
  const tokenLimit = await checkRateLimit(`widget:submit:token:${config.token}`, {
    limit: 50,
    windowMs: 60 * 60_000,
  });
  if (!tokenLimit.ok) {
    return NextResponse.json(
      { ok: false, error: 'rate_limited', retryAfter: describeRetryAfter(tokenLimit.retryAfterMs) },
      { status: 429, headers: cors },
    );
  }

  let body: SubmitBody;
  try {
    body = (await req.json()) as SubmitBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400, headers: cors });
  }

  const name = asString(body.name, MAX_NAME);
  const phone = asString(body.phone, MAX_PHONE);
  const description = asString(body.description, MAX_DESCRIPTION);
  const email =
    typeof body.email === 'string' && body.email.trim() ? asString(body.email, MAX_EMAIL) : null;

  if (!name || !phone || !description || description.length < MIN_DESCRIPTION) {
    return NextResponse.json(
      { ok: false, error: 'missing_required_fields' },
      { status: 400, headers: cors },
    );
  }

  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (rawAttachments.length > MAX_PHOTOS) {
    return NextResponse.json(
      { ok: false, error: 'too_many_photos', maxPhotos: MAX_PHOTOS },
      { status: 400, headers: cors },
    );
  }
  const attachments: Array<{ path: string; mime: string }> = [];
  for (const a of rawAttachments) {
    if (!a || typeof a !== 'object') continue;
    const rec = a as { path?: unknown; mime?: unknown };
    if (typeof rec.path !== 'string' || rec.path.length === 0 || rec.path.length >= 500) continue;
    const mime = typeof rec.mime === 'string' ? rec.mime.toLowerCase() : '';
    if (!ALLOWED_ATTACHMENT_MIMES.has(mime)) continue;
    attachments.push({ path: rec.path, mime });
  }

  const intake = await createIntakeDraftFromWidgetAction({
    tenantId: config.tenantId,
    name,
    phone,
    email,
    description,
    attachments,
  });
  if (!intake.ok) {
    return NextResponse.json({ ok: false, error: intake.error }, { status: 500, headers: cors });
  }

  // Run the universal classifier. We await so the draft is in a useful
  // state by the time the notification lands in the operator's inbox,
  // but a classifier failure doesn't bounce the submission — the draft
  // row captures the error and the operator can reclassify from /inbox.
  await parseIntakeDraftAction(intake.draftId).catch((err) => {
    console.error('[widget/submit] parseIntakeDraftAction failed', {
      draftId: intake.draftId,
      error: err,
    });
  });

  // Notify the operator. Best-effort: a failed notification doesn't
  // invalidate the lead — it's still in /inbox/intake.
  try {
    const admin = createAdminClient();
    const { data: tenant } = await admin
      .from('tenants')
      .select('name, contact_email')
      .eq('id', config.tenantId)
      .maybeSingle();

    const contactEmail = (tenant?.contact_email as string | null | undefined)?.trim();
    if (contactEmail) {
      const businessName = (tenant?.name as string | undefined) ?? 'there';
      const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://app.heyhenry.io').replace(
        /\/$/,
        '',
      );
      const intakeUrl = `${baseUrl}/inbox/intake/${intake.draftId}`;

      await sendEmail({
        tenantId: config.tenantId,
        to: contactEmail,
        subject: `New lead via your website — ${name}`,
        html: widgetLeadNotificationHtml({
          businessName,
          customerName: name,
          customerPhone: phone,
          customerEmail: email,
          description,
          photoCount: attachments.length,
          intakeUrl,
        }),
        caslCategory: 'transactional',
        caslEvidence: {
          surface: 'widget',
          intake_draft_id: intake.draftId,
          widget_config_id: config.id,
        },
        relatedType: 'lead',
        relatedId: intake.draftId,
      });
    } else {
      console.warn('[widget/submit] tenant has no contact_email; skipping notification', {
        tenantId: config.tenantId,
        draftId: intake.draftId,
      });
    }
  } catch (err) {
    console.error('[widget/submit] notification email failed', {
      draftId: intake.draftId,
      error: err,
    });
  }

  return NextResponse.json({ ok: true, draftId: intake.draftId }, { status: 200, headers: cors });
}
