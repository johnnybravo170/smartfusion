/**
 * API-key generation + hashing + request-signature verification.
 *
 * Secrets: 256-bit random, base64url-encoded. Shown once to the admin at
 * creation time, then discarded from memory. Stored server-side as
 * HMAC-SHA256(secret, pepper) hex.
 *
 * Why HMAC-SHA256 and not Argon2: API key secrets are high-entropy tokens
 * we generate (not user passwords). The point of argon2/bcrypt is to slow
 * brute-force against low-entropy input, which does not apply. A plain
 * cryptographic hash is both correct and fast. Pepper makes a dumped DB
 * alone insufficient to verify keys.
 *
 * Format: ops_<keyId>_<secret> where keyId is the row UUID and secret is
 * base64url(32 random bytes). The keyId prefix lets us look up the row
 * by a straight `WHERE id = ...`, then verify the secret.
 */

import { env } from './env';

const SECRET_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateRawSecret(): string {
  const buf = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

export function formatKey(keyId: string, secret: string): string {
  return `ops_${keyId}_${secret}`;
}

export function parseKey(raw: string): { keyId: string; secret: string } | null {
  if (!raw.startsWith('ops_')) return null;
  const rest = raw.slice(4);
  const underscore = rest.indexOf('_');
  if (underscore < 0) return null;
  const keyId = rest.slice(0, underscore);
  const secret = rest.slice(underscore + 1);
  if (!/^[0-9a-f-]{36}$/.test(keyId) || secret.length < 20) return null;
  return { keyId, secret };
}

export async function hashSecret(secret: string): Promise<string> {
  const enc = new TextEncoder();
  const keyData = enc.encode(env.opsKeyPepper);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(secret));
  return Buffer.from(signature).toString('hex');
}

/** Constant-time comparison to avoid timing leaks. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/**
 * HMAC request signature: hex(HMAC-SHA256(secret, `${timestamp}|${method}|${path}|${bodySha256}`))
 * Timestamp is unix seconds. Path includes querystring.
 */
export async function computeRequestSignature(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  bodySha256: string,
): Promise<string> {
  const enc = new TextEncoder();
  const keyData = enc.encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const message = `${timestamp}|${method.toUpperCase()}|${path}|${bodySha256}`;
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Buffer.from(signature).toString('hex');
}

export async function sha256Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Buffer.from(hash).toString('hex');
}

/** Scope checks. Each endpoint declares the scope it needs. */
export type Scope =
  | 'read:worklog'
  | 'write:worklog'
  | 'admin:worklog'
  | 'read:roadmap'
  | 'write:roadmap'
  | 'admin:roadmap'
  | 'read:ideas'
  | 'write:ideas'
  | 'read:decisions'
  | 'write:decisions'
  | 'read:knowledge'
  | 'write:knowledge'
  | 'read:competitors'
  | 'write:competitors'
  | 'read:incidents'
  | 'write:incidents'
  | 'read:social'
  | 'write:social'
  | 'read:docs'
  | 'write:docs'
  | 'read:review_queue'
  | 'write:escalate'
  | 'read:kanban'
  | 'write:kanban'
  | 'write:email'
  | 'admin:maintenance'
  | 'admin:keys';

export function hasScope(granted: string[], required: Scope): boolean {
  return granted.includes(required);
}
