/**
 * Shared Resend-backed email send used by both the REST route
 * (`/api/ops/email/send`) and the MCP tool (`ops_email_send`).
 *
 * Keeps the Resend HTTP call + validation + audit-logging in one place so
 * routes/tools don't each re-implement the wire format.
 *
 * Env:
 *   RESEND_API_KEY           — required, sending-only Resend key
 *   OPS_EMAIL_DEFAULT_FROM   — fallback `from` when caller omits it
 */
import { createServiceClient } from '@/lib/supabase';

export type EmailTag = { name: string; value: string };

export type SendEmailInput = {
  to: string | string[];
  from?: string;
  subject: string;
  html?: string;
  text?: string;
  reply_to?: string;
  tags?: EmailTag[];
};

export type SendEmailResult =
  | { ok: true; id: string; to: string[]; subject: string }
  | { ok: false; status: number; error: string };

const MAX_PAYLOAD_BYTES = 200 * 1024; // 200KB soft cap

export function validateEmailInput(
  input: SendEmailInput,
): { ok: true } | { ok: false; error: string } {
  if (!input.subject || input.subject.length < 1 || input.subject.length > 250) {
    return { ok: false, error: 'subject must be 1–250 chars' };
  }
  if (!input.html && !input.text) {
    return { ok: false, error: 'at least one of html or text is required' };
  }
  const size =
    Buffer.byteLength(input.subject, 'utf8') +
    (input.html ? Buffer.byteLength(input.html, 'utf8') : 0) +
    (input.text ? Buffer.byteLength(input.text, 'utf8') : 0);
  if (size > MAX_PAYLOAD_BYTES) {
    return { ok: false, error: `payload exceeds 200KB (${size} bytes)` };
  }
  return { ok: true };
}

/**
 * Send an email via Resend and write an audit_log row with the outcome.
 *
 * `auditKeyId` is the ops.api_keys.id for REST callers, `null` for OAuth.
 * `auditPath` is the logical path to stamp on the audit row so both the
 * REST route and the MCP tool can share this function.
 */
export async function sendOpsEmail(
  input: SendEmailInput,
  audit: { keyId: string | null; path: string; method?: string },
): Promise<SendEmailResult> {
  const validation = validateEmailInput(input);
  if (!validation.ok) {
    await writeAudit(audit, 400, validation.error);
    return { ok: false, status: 400, error: validation.error };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    const msg = 'RESEND_API_KEY not set';
    await writeAudit(audit, 500, msg);
    return { ok: false, status: 500, error: msg };
  }

  const from = input.from ?? process.env.OPS_EMAIL_DEFAULT_FROM;
  if (!from) {
    const msg = 'OPS_EMAIL_DEFAULT_FROM not set and no from provided';
    await writeAudit(audit, 500, msg);
    return { ok: false, status: 500, error: msg };
  }

  const toList = Array.isArray(input.to) ? input.to : [input.to];

  const payload: Record<string, unknown> = {
    from,
    to: toList,
    subject: input.subject,
  };
  if (input.html) payload.html = input.html;
  if (input.text) payload.text = input.text;
  if (input.reply_to) payload.reply_to = input.reply_to;
  if (input.tags) payload.tags = input.tags;

  let res: Response;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeAudit(audit, 500, msg);
    return { ok: false, status: 500, error: msg };
  }

  const bodyText = await res.text();
  let body: { id?: string; message?: string; name?: string } = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = {};
  }

  if (!res.ok) {
    const msg = body.message ?? body.name ?? `Resend ${res.status}`;
    await writeAudit(audit, 500, `resend: ${msg}`);
    return { ok: false, status: res.status, error: msg };
  }

  const id = body.id ?? '';
  await writeAudit(audit, 200, `subject=${input.subject.slice(0, 100)}`);
  return { ok: true, id, to: toList, subject: input.subject };
}

async function writeAudit(
  audit: { keyId: string | null; path: string; method?: string },
  status: number,
  reason: string,
) {
  try {
    const service = createServiceClient();
    await service
      .schema('ops')
      .from('audit_log')
      .insert({
        key_id: audit.keyId,
        method: audit.method ?? 'POST',
        path: audit.path,
        status,
        reason: reason.slice(0, 500),
      });
  } catch {
    // never let audit failure break the send path
  }
}

export function resendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}
