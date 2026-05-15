/**
 * Mint a one-shot signed PUT URL for a widget photo upload.
 *
 * Path scope: `widget/<tenant_id>/<uuid>.<ext>` in the `intake-audio`
 * bucket. The bucket name is historical — it stages images + PDFs too;
 * see `src/server/actions/inbound-email-intake.ts` for the same pattern.
 *
 * Why a separate endpoint instead of proxying multipart through Vercel:
 * mobile photos commonly exceed Vercel's 4.5 MB body limit. Direct PUT
 * to Supabase bypasses the function entirely. Abuse-bounded: each URL
 * scopes to a single object path, and issuance is rate-limited.
 */

import { randomUUID } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { callerIp, checkRateLimit, describeRetryAfter } from '@/lib/rate-limit';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticateWidgetRequest } from '@/lib/widget/auth';
import { widgetCorsHeaders } from '@/lib/widget/cors';

const INTAKE_BUCKET = 'intake-audio';

const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'image/webp': 'webp',
};

// 25 MB. Plenty of room for un-compressed iPhone shots while still
// bounded so a leaked token can't fill the bucket with one upload.
const MAX_SIZE_BYTES = 25 * 1024 * 1024;

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: widgetCorsHeaders(req.headers.get('origin')),
  });
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

  if (!config.photosEnabled) {
    return NextResponse.json(
      { ok: false, error: 'photos_disabled' },
      { status: 403, headers: cors },
    );
  }

  // Rate-limit issuance. Per-IP first (catches a single bad actor
  // browser), per-token second (catches a leaked token spread across
  // many IPs).
  const ip = await callerIp();
  const ipLimit = await checkRateLimit(`widget:upload-url:ip:${ip}`, {
    limit: 10,
    windowMs: 60 * 60_000,
  });
  if (!ipLimit.ok) {
    return NextResponse.json(
      { ok: false, error: `rate_limited`, retryAfter: describeRetryAfter(ipLimit.retryAfterMs) },
      { status: 429, headers: cors },
    );
  }
  const tokenLimit = await checkRateLimit(`widget:upload-url:token:${config.token}`, {
    limit: 50,
    windowMs: 60 * 60_000,
  });
  if (!tokenLimit.ok) {
    return NextResponse.json(
      { ok: false, error: `rate_limited`, retryAfter: describeRetryAfter(tokenLimit.retryAfterMs) },
      { status: 429, headers: cors },
    );
  }

  let body: { mime?: unknown; sizeBytes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400, headers: cors });
  }

  const mime = typeof body.mime === 'string' ? body.mime.toLowerCase() : '';
  const ext = ALLOWED_MIME[mime];
  if (!ext) {
    return NextResponse.json(
      { ok: false, error: 'unsupported_mime' },
      { status: 400, headers: cors },
    );
  }

  const sizeBytes = typeof body.sizeBytes === 'number' ? body.sizeBytes : 0;
  if (sizeBytes <= 0 || sizeBytes > MAX_SIZE_BYTES) {
    return NextResponse.json(
      { ok: false, error: 'size_out_of_range', maxBytes: MAX_SIZE_BYTES },
      { status: 400, headers: cors },
    );
  }

  const path = `widget/${config.tenantId}/${randomUUID()}.${ext}`;
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(INTAKE_BUCKET).createSignedUploadUrl(path);

  if (error || !data) {
    console.error('[widget/signed-upload-url] createSignedUploadUrl failed', {
      tenantId: config.tenantId,
      error: error?.message,
    });
    return NextResponse.json(
      { ok: false, error: 'signed_url_failed' },
      { status: 500, headers: cors },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      path,
      uploadUrl: data.signedUrl,
      token: data.token,
    },
    { status: 200, headers: cors },
  );
}
