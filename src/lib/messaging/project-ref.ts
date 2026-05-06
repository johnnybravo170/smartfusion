/**
 * Project reference token for the body footer fallback in customer email
 * replies. We append `[Ref: P-xxxxxx]` to every customer-facing email; on
 * inbound, we parse it as a redundant identifier when In-Reply-To is
 * mangled or stripped.
 *
 * Tokens are HMAC of project_id truncated to 6 base32 chars (~30 bits).
 * Deterministic — no DB column writes, no collision retry. Reversible
 * only with the server-side secret; harmless if leaked because the
 * inbound flow still requires the sender to match a customer email.
 */

import crypto from 'node:crypto';

const SECRET = process.env.PROJECT_REF_SECRET ?? process.env.SUPABASE_JWT_SECRET ?? 'dev-fallback';
const TOKEN_LENGTH = 6;
// Crockford base32 alphabet — no I/L/O/U to avoid OCR / read-aloud confusion.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function bytesToBase32(bytes: Buffer, length: number): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += ALPHABET[(value >>> (bits - 5)) & 0b11111];
      bits -= 5;
    }
    if (out.length >= length) break;
  }
  return out;
}

export function projectRefToken(projectId: string): string {
  const hmac = crypto.createHmac('sha256', SECRET).update(projectId).digest();
  return bytesToBase32(hmac, TOKEN_LENGTH);
}

/**
 * Verify a candidate token matches a project. Used on inbound to
 * confirm the parsed footer token corresponds to one of the candidate
 * projects from the customer-email lookup. Constant-time compare.
 */
export function projectRefMatches(projectId: string, candidate: string): boolean {
  const expected = projectRefToken(projectId);
  if (expected.length !== candidate.length) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(candidate.toUpperCase());
  return crypto.timingSafeEqual(a, b);
}

/**
 * Extract the first ref token from a body. Tolerant of common email
 * mangling — extra whitespace, lowercased, surrounded by quote marks
 * from forwarded threads.
 */
export function parseProjectRefFromBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = body.match(/\bRef:\s*P-([0-9A-Za-z]{6})\b/);
  return match ? match[1].toUpperCase() : null;
}

/**
 * The visible footer string we append to customer-facing emails. Kept
 * simple so it survives quoting in any client. The `[Ref: ...]` form is
 * conventional enough to look like a normal reference number rather
 * than tracking metadata.
 */
export function projectRefFooter(projectId: string): string {
  return `[Ref: P-${projectRefToken(projectId)}]`;
}
