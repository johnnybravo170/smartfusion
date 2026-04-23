/**
 * OAuth 2.1 token endpoint.
 *
 * No auth gate — that's the point of OAuth. Validates the authorization
 * code (PKCE S256) or refresh token and issues an opaque access + refresh
 * token pair. Raw tokens are returned once and only their sha256 hash is
 * stored.
 */
import {
  ACCESS_TOKEN_TTL_SECONDS,
  generateOpaqueToken,
  REFRESH_TOKEN_TTL_SECONDS,
  sha256Hex,
  verifyPkceS256,
} from '@/lib/oauth';
import { createServiceClient } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type FormBag = Record<string, string>;

function err(status: number, code: string, description?: string): Response {
  const body: Record<string, string> = { error: code };
  if (description) body.error_description = description;
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      pragma: 'no-cache',
    },
  });
}

async function readForm(req: Request): Promise<FormBag> {
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.includes('application/x-www-form-urlencoded')) return {};
  const text = await req.text();
  const params = new URLSearchParams(text);
  const out: FormBag = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

export async function POST(req: Request) {
  const form = await readForm(req);
  const grant_type = form.grant_type ?? '';

  if (grant_type === 'authorization_code') {
    return handleAuthCode(form);
  }
  if (grant_type === 'refresh_token') {
    return handleRefresh(form);
  }
  return err(400, 'unsupported_grant_type', `grant_type "${grant_type}" not supported`);
}

async function handleAuthCode(form: FormBag): Promise<Response> {
  const code = form.code ?? '';
  const verifier = form.code_verifier ?? '';
  const client_id = form.client_id ?? '';
  const redirect_uri = form.redirect_uri ?? '';

  if (!code || !verifier || !client_id || !redirect_uri) {
    return err(400, 'invalid_request', 'missing required parameter');
  }

  const service = createServiceClient();
  const { data: row } = await service
    .schema('ops')
    .from('oauth_codes')
    .select(
      'code, client_id, redirect_uri, code_challenge, scopes, user_id, expires_at, consumed_at',
    )
    .eq('code', code)
    .maybeSingle();

  if (!row) return err(400, 'invalid_grant', 'unknown code');
  if (row.consumed_at) return err(400, 'invalid_grant', 'code already used');
  if (new Date(row.expires_at as string).getTime() < Date.now()) {
    return err(400, 'invalid_grant', 'code expired');
  }
  if (row.client_id !== client_id) return err(400, 'invalid_grant', 'client_id mismatch');
  if (row.redirect_uri !== redirect_uri) return err(400, 'invalid_grant', 'redirect_uri mismatch');

  const ok = await verifyPkceS256(verifier, row.code_challenge as string);
  if (!ok) return err(400, 'invalid_grant', 'PKCE verification failed');

  // Single-use: mark consumed BEFORE issuing tokens so a parallel exchange races to one.
  const { error: consumeErr } = await service
    .schema('ops')
    .from('oauth_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('code', code)
    .is('consumed_at', null);
  if (consumeErr) return err(400, 'invalid_grant', 'code already used');

  return issueTokenPair({
    service,
    client_id,
    scopes: row.scopes as string[],
    user_id: row.user_id as string,
    parent_token_id: null,
  });
}

async function handleRefresh(form: FormBag): Promise<Response> {
  const refresh = form.refresh_token ?? '';
  const client_id = form.client_id ?? '';
  if (!refresh || !client_id) return err(400, 'invalid_request', 'missing required parameter');

  const service = createServiceClient();
  const refreshHash = await sha256Hex(refresh);
  const { data: row } = await service
    .schema('ops')
    .from('oauth_tokens')
    .select('id, client_id, scopes, user_id, created_at, revoked_at')
    .eq('refresh_token_hash', refreshHash)
    .maybeSingle();

  if (!row) return err(400, 'invalid_grant', 'unknown refresh token');
  if (row.revoked_at) return err(400, 'invalid_grant', 'refresh token revoked');
  // Refresh family is valid for REFRESH_TOKEN_TTL_SECONDS from issue.
  const refreshExpiresAt =
    new Date(row.created_at as string).getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000;
  if (refreshExpiresAt < Date.now()) {
    return err(400, 'invalid_grant', 'refresh token expired');
  }
  if (row.client_id !== client_id) return err(400, 'invalid_grant', 'client_id mismatch');

  // Rotate: revoke the old, link new via parent_token_id.
  await service
    .schema('ops')
    .from('oauth_tokens')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', row.id as string);

  return issueTokenPair({
    service,
    client_id,
    scopes: row.scopes as string[],
    user_id: row.user_id as string,
    parent_token_id: row.id as string,
  });
}

async function issueTokenPair(args: {
  service: ReturnType<typeof createServiceClient>;
  client_id: string;
  scopes: string[];
  user_id: string;
  parent_token_id: string | null;
}): Promise<Response> {
  const accessToken = generateOpaqueToken();
  const refreshToken = generateOpaqueToken();
  const accessHash = await sha256Hex(accessToken);
  const refreshHash = await sha256Hex(refreshToken);
  // expires_at = access-token expiry (1h). Refresh-token validity is
  // computed from created_at + REFRESH_TOKEN_TTL_SECONDS at refresh time.
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString();

  const { error } = await args.service.schema('ops').from('oauth_tokens').insert({
    access_token_hash: accessHash,
    refresh_token_hash: refreshHash,
    client_id: args.client_id,
    scopes: args.scopes,
    user_id: args.user_id,
    expires_at: expiresAt,
    parent_token_id: args.parent_token_id,
  });

  if (error) return err(500, 'server_error', error.message);

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: args.scopes.join(' '),
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        pragma: 'no-cache',
      },
    },
  );
}
