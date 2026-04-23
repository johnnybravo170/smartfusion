/**
 * Agent API request authentication.
 *
 * Every `/api/ops/*` route funnels through `authenticateRequest` before any
 * business logic runs. On success returns the key record + scopes; on
 * failure returns a Response with an appropriate status code AND logs the
 * attempt to ops.audit_log so we have a forensic trail.
 *
 * Checks performed, in order:
 *   1. Authorization header present and parseable
 *   2. Timestamp header within ±5 minutes (replay window)
 *   3. Signature header present and matches HMAC of canonical request
 *   4. Key exists, not revoked, not expired
 *   5. Required scope granted
 *   6. Destructive op (archive/delete/admin:*) has a non-empty X-Ops-Reason
 *   7. Rate limit has headroom
 *
 * Anything that fails writes a row with status=401/403/429 to audit_log.
 * Successful requests write status=200 AFTER the handler runs (called from
 * the route using logAuditSuccess below).
 */

import { NextResponse } from 'next/server';
import {
  computeRequestSignature,
  hashSecret,
  hasScope,
  parseKey,
  type Scope,
  safeEqual,
  sha256Hex,
} from './keys';
import { createServiceClient } from './supabase';

const TIMESTAMP_WINDOW_SECONDS = 300;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

export type AuthedKey = {
  id: string;
  name: string;
  scopes: string[];
  ip: string | null;
  reason: string | null;
};

export type AuthResult =
  | { ok: true; key: AuthedKey; bodySha: string; reason: string | null }
  | { ok: false; response: Response };

export async function authenticateRequest(
  req: Request,
  opts: { requiredScope: Scope; destructive?: boolean },
): Promise<AuthResult> {
  const url = new URL(req.url);
  const path = url.pathname + url.search;
  const method = req.method.toUpperCase();
  const ip = readClientIp(req);
  const userAgent = req.headers.get('user-agent') ?? null;

  // 1. Parse Authorization.
  const authHeader = req.headers.get('authorization') ?? '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const parsed = parseKey(bearer);
  if (!parsed) {
    await audit(null, null, method, path, 401, ip, userAgent, null, null);
    return { ok: false, response: json(401, 'Unauthorized') };
  }

  // 2. Timestamp check.
  const tsHeader = req.headers.get('x-ops-timestamp') ?? '';
  const timestamp = Number(tsHeader);
  if (!Number.isFinite(timestamp)) {
    await audit(parsed.keyId, null, method, path, 401, ip, userAgent, null, null);
    return { ok: false, response: json(401, 'Invalid timestamp') };
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > TIMESTAMP_WINDOW_SECONDS) {
    await audit(parsed.keyId, null, method, path, 401, ip, userAgent, null, null);
    return { ok: false, response: json(401, 'Timestamp outside window') };
  }

  // Read body once, hash it, then let the route have it if it wants.
  const bodyText = method === 'GET' || method === 'HEAD' ? '' : await req.clone().text();
  const bodySha = await sha256Hex(bodyText);

  // 3. Signature check.
  const providedSig = req.headers.get('x-ops-signature') ?? '';
  const expectedSig = await computeRequestSignature(
    parsed.secret,
    String(timestamp),
    method,
    path,
    bodySha,
  );
  if (!providedSig || !safeEqual(providedSig.toLowerCase(), expectedSig.toLowerCase())) {
    await audit(parsed.keyId, null, method, path, 401, ip, userAgent, bodySha, null);
    return { ok: false, response: json(401, 'Invalid signature') };
  }

  // 4. Key lookup.
  const service = createServiceClient();
  const { data: keyRow } = await service
    .schema('ops')
    .from('api_keys')
    .select('id, name, scopes, secret_hash, expires_at, revoked_at')
    .eq('id', parsed.keyId)
    .maybeSingle();

  if (!keyRow) {
    await audit(parsed.keyId, null, method, path, 401, ip, userAgent, bodySha, null);
    return { ok: false, response: json(401, 'Invalid key') };
  }
  if (keyRow.revoked_at) {
    await audit(parsed.keyId, null, method, path, 401, ip, userAgent, bodySha, null);
    return { ok: false, response: json(401, 'Key revoked') };
  }
  if (new Date(keyRow.expires_at as string).getTime() < Date.now()) {
    await audit(parsed.keyId, null, method, path, 401, ip, userAgent, bodySha, null);
    return { ok: false, response: json(401, 'Key expired') };
  }

  const expectedHash = await hashSecret(parsed.secret);
  if (!safeEqual(expectedHash, keyRow.secret_hash as string)) {
    await audit(parsed.keyId, null, method, path, 401, ip, userAgent, bodySha, null);
    return { ok: false, response: json(401, 'Invalid key') };
  }

  // 5. Scope check.
  const scopes = (keyRow.scopes as string[]) ?? [];
  if (!hasScope(scopes, opts.requiredScope)) {
    await audit(parsed.keyId, null, method, path, 403, ip, userAgent, bodySha, null);
    return { ok: false, response: json(403, 'Forbidden') };
  }

  // 6. Destructive ops require a reason.
  const reason = req.headers.get('x-ops-reason')?.trim() || null;
  if (opts.destructive && !reason) {
    await audit(parsed.keyId, null, method, path, 400, ip, userAgent, bodySha, null);
    return { ok: false, response: json(400, 'X-Ops-Reason required') };
  }

  // 7. Rate limit.
  const allowed = await checkRateLimit(parsed.keyId);
  if (!allowed) {
    await audit(parsed.keyId, null, method, path, 429, ip, userAgent, bodySha, reason);
    return {
      ok: false,
      response: new NextResponse(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '60' },
      }),
    };
  }

  // Update last_used bookkeeping — best-effort.
  await service
    .schema('ops')
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString(), last_used_ip: ip })
    .eq('id', parsed.keyId);

  return {
    ok: true,
    key: {
      id: keyRow.id as string,
      name: keyRow.name as string,
      scopes,
      ip,
      reason,
    },
    bodySha,
    reason,
  };
}

export type OAuthToken = {
  id: string;
  client_id: string;
  scopes: string[];
  user_id: string;
};

export type OAuthAuthResult = { ok: true; token: OAuthToken } | { ok: false; response: Response };

/**
 * OAuth 2.1 bearer-token auth for the remote MCP endpoint.
 *
 * Looks up `Authorization: Bearer <opaque>` against `ops.oauth_tokens` by
 * sha256 hash. Per-tool scope enforcement is still done inside each tool
 * handler via `withAudit`. On 401 we attach a `WWW-Authenticate` header
 * pointing at the protected-resource metadata so the client can discover
 * the auth server (RFC 9728).
 */
export async function authenticateOAuthToken(req: Request): Promise<OAuthAuthResult> {
  const origin = new URL(req.url).origin;
  const wwwAuth = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;

  const authHeader = req.headers.get('authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return { ok: false, response: oauthChallenge(401, 'invalid_token', wwwAuth) };
  }
  const raw = authHeader.slice(7).trim();
  if (!raw) return { ok: false, response: oauthChallenge(401, 'invalid_token', wwwAuth) };

  const accessHash = await sha256Hex(raw);
  const service = createServiceClient();
  const { data: row } = await service
    .schema('ops')
    .from('oauth_tokens')
    .select('id, client_id, scopes, user_id, expires_at, revoked_at')
    .eq('access_token_hash', accessHash)
    .maybeSingle();

  if (!row) return { ok: false, response: oauthChallenge(401, 'invalid_token', wwwAuth) };
  if (row.revoked_at) return { ok: false, response: oauthChallenge(401, 'invalid_token', wwwAuth) };
  if (new Date(row.expires_at as string).getTime() < Date.now()) {
    return { ok: false, response: oauthChallenge(401, 'invalid_token', wwwAuth) };
  }

  return {
    ok: true,
    token: {
      id: row.id as string,
      client_id: row.client_id as string,
      scopes: (row.scopes as string[]) ?? [],
      user_id: row.user_id as string,
    },
  };
}

function oauthChallenge(status: number, error: string, wwwAuth: string): Response {
  return new NextResponse(JSON.stringify({ error }), {
    status,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `${wwwAuth}, error="${error}"`,
    },
  });
}

/** Call from a route AFTER the handler succeeds so success is logged too. */
export async function logAuditSuccess(
  keyId: string,
  method: string,
  path: string,
  status: number,
  ip: string | null,
  userAgent: string | null,
  bodySha: string,
  reason: string | null,
) {
  await audit(keyId, null, method, path, status, ip, userAgent, bodySha, reason);
}

async function audit(
  keyId: string | null,
  adminUserId: string | null,
  method: string,
  path: string,
  status: number,
  ip: string | null,
  userAgent: string | null,
  bodySha: string | null,
  reason: string | null,
) {
  try {
    const service = createServiceClient();
    await service.schema('ops').from('audit_log').insert({
      key_id: keyId,
      admin_user_id: adminUserId,
      method,
      path,
      status,
      ip,
      user_agent: userAgent,
      body_sha256: bodySha,
      reason,
    });
  } catch {
    // Never let audit failure 500 the request — but do surface via alert
    // pipeline (future).
  }
}

async function checkRateLimit(keyId: string): Promise<boolean> {
  const service = createServiceClient();
  const windowStart = new Date(Date.now() - 60_000).toISOString();

  // Prune old rows for this key, then count + insert atomically enough.
  await service
    .schema('ops')
    .from('rate_limit_events')
    .delete()
    .eq('key_id', keyId)
    .lt('occurred_at', windowStart);

  const { count } = await service
    .schema('ops')
    .from('rate_limit_events')
    .select('*', { count: 'exact', head: true })
    .eq('key_id', keyId);

  if ((count ?? 0) >= DEFAULT_RATE_LIMIT_PER_MINUTE) return false;

  await service.schema('ops').from('rate_limit_events').insert({ key_id: keyId });
  return true;
}

function readClientIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]?.trim() || null;
  return req.headers.get('x-real-ip');
}

function json(status: number, error: string): Response {
  return new NextResponse(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
