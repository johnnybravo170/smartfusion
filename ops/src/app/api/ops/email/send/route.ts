/**
 * POST /api/ops/email/send — send a transactional email via Resend.
 *
 * HMAC-authed like every other `/api/ops/*` route. Scope: `write:email`.
 *
 * Env:
 *   RESEND_API_KEY           — required
 *   OPS_EMAIL_DEFAULT_FROM   — fallback `from`
 *
 * GET on this path returns a health snippet — handy for "is this alive?"
 * without leaking the key.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequest, logAuditSuccess } from '@/lib/api-auth';
import { resendConfigured, sendOpsEmail } from '@/server/ops-services/email';

const tagSchema = z.object({
  name: z.string().min(1).max(256),
  value: z.string().min(1).max(256),
});

const bodySchema = z
  .object({
    to: z.union([z.string().email(), z.array(z.string().email()).min(1)]),
    from: z.string().optional(),
    subject: z.string().min(1).max(250),
    html: z.string().optional(),
    text: z.string().optional(),
    reply_to: z.string().email().optional(),
    tags: z.array(tagSchema).optional(),
  })
  .refine((v) => Boolean(v.html) || Boolean(v.text), {
    message: 'At least one of html or text is required',
  });

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: '/api/ops/email/send',
    resend_configured: resendConfigured(),
    default_from_configured: Boolean(process.env.OPS_EMAIL_DEFAULT_FROM),
  });
}

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req, { requiredScope: 'write:email' });
  if (!auth.ok) return auth.response;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const path = url.pathname + url.search;

  const result = await sendOpsEmail(parsed.data, {
    keyId: auth.key.id,
    path: url.pathname,
    method: 'POST',
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, status: result.status, error: result.error },
      { status: result.status >= 400 && result.status < 600 ? result.status : 500 },
    );
  }

  await logAuditSuccess(
    auth.key.id,
    'POST',
    path,
    200,
    auth.key.ip,
    req.headers.get('user-agent'),
    auth.bodySha,
    auth.reason,
  );

  return NextResponse.json({
    ok: true,
    id: result.id,
    to: result.to,
    subject: result.subject,
  });
}
