/**
 * OAuth 2.1 provider helpers for the ops MCP endpoint.
 *
 * Issues opaque tokens (32 random bytes, base64url) and stores only sha256
 * hashes server-side. PKCE S256 is the only challenge method we accept.
 *
 * See migration 0087_ops_oauth.sql and /api/mcp/route.ts for callers.
 */

const TOKEN_BYTES = 32;

const ALL_SCOPES = [
  'read:docs',
  'write:docs',
  'read:knowledge',
  'write:knowledge',
  'read:competitors',
  'write:competitors',
  'read:incidents',
  'write:incidents',
  'read:social',
  'write:social',
  'read:roadmap',
  'write:roadmap',
  'read:ideas',
  'write:ideas',
  'read:decisions',
  'write:decisions',
  'read:worklog',
  'write:worklog',
  'read:review_queue',
  'write:escalate',
] as const;

export const SUPPORTED_SCOPES: readonly string[] = ALL_SCOPES;

/** Anthropic's fixed Routines callback. We refuse anything else. */
export const ALLOWED_REDIRECT_PREFIX = 'https://claude.ai/api/mcp/auth_callback';

function toBase64Url(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateOpaqueToken(): string {
  const buf = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

export async function sha256Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Buffer.from(hash).toString('hex');
}

/** PKCE S256: base64url(sha256(verifier)) === stored challenge. */
export async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const computed = toBase64Url(new Uint8Array(hash));
  // Constant-time-ish — both base64url strings are fixed length when valid.
  if (computed.length !== challenge.length) return false;
  let out = 0;
  for (let i = 0; i < computed.length; i++) {
    out |= computed.charCodeAt(i) ^ challenge.charCodeAt(i);
  }
  return out === 0;
}

export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const AUTH_CODE_TTL_SECONDS = 600;
