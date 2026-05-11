/**
 * QuickBooks Online OAuth 2.0 primitives.
 *
 * - State cookie: HMAC-signed payload {tenantId, nonce, expiresAt}.
 *   Avoids a DB table — verified on callback to defend against CSRF.
 * - Token exchange: code → access/refresh tokens.
 * - Token refresh: refresh_token → new access/refresh pair (Intuit
 *   rotates refresh tokens on every refresh).
 */

import crypto from 'node:crypto';
import { getQboEnv, QBO_OAUTH_REVOKE_URL, QBO_OAUTH_TOKEN_URL } from './env';

// =====================================================================
// State cookie
// =====================================================================

const STATE_TTL_MS = 10 * 60 * 1000; // 10 min — long enough for any user, short enough to limit replay window

export type QboOAuthState = {
  tenantId: string;
  nonce: string;
  expiresAt: number;
};

/**
 * Encode + HMAC-sign an OAuth state payload. Returned string is safe to
 * use as the `state` query param on the authorize URL.
 *
 * Format: `<base64url(payload)>.<base64url(hmac)>`
 */
export function signState(tenantId: string): string {
  const payload: QboOAuthState = {
    tenantId,
    nonce: crypto.randomBytes(12).toString('base64url'),
    expiresAt: Date.now() + STATE_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = hmac(body);
  return `${body}.${sig}`;
}

/**
 * Verify a state string. Returns the decoded payload on success, `null`
 * on any failure (bad shape, bad signature, expired).
 */
export function verifyState(stateParam: string): QboOAuthState | null {
  const parts = stateParam.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;

  const expected = hmac(body);
  // Constant-time compare to defeat timing attacks.
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  let payload: QboOAuthState;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as QboOAuthState;
  } catch {
    return null;
  }

  if (!payload.tenantId || !payload.nonce || !payload.expiresAt) return null;
  if (Date.now() > payload.expiresAt) return null;

  return payload;
}

function hmac(body: string): string {
  return crypto.createHmac('sha256', getQboEnv().stateSecret).update(body).digest('base64url');
}

// =====================================================================
// Token exchange + refresh
// =====================================================================

export type QboTokens = {
  accessToken: string;
  refreshToken: string;
  /** ms since epoch */
  expiresAt: number;
  /** ms since epoch — refresh tokens expire after ~100 days */
  refreshTokenExpiresAt: number;
};

type IntuitTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  x_refresh_token_expires_in: number; // seconds
  token_type: 'bearer';
};

/**
 * Exchange an OAuth `code` (from the callback redirect) for tokens.
 * Throws on any non-2xx response.
 */
export async function exchangeCodeForTokens(code: string): Promise<QboTokens> {
  const env = getQboEnv();
  const res = await fetch(QBO_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(env.clientId, env.clientSecret)}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.redirectUri,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`QBO token exchange failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as IntuitTokenResponse;
  return parseTokenResponse(json);
}

/**
 * Refresh an access token. Intuit rotates refresh tokens on every call,
 * so we always persist the response back.
 */
export async function refreshTokens(refreshToken: string): Promise<QboTokens> {
  const env = getQboEnv();
  const res = await fetch(QBO_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(env.clientId, env.clientSecret)}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`QBO token refresh failed: ${res.status} ${text}`);
  }
  const json = (await res.json()) as IntuitTokenResponse;
  return parseTokenResponse(json);
}

/**
 * Revoke a refresh token (or access token) at Intuit. Best-effort —
 * we still clear local tokens even if this fails.
 */
export async function revokeToken(token: string): Promise<void> {
  const env = getQboEnv();
  await fetch(QBO_OAUTH_REVOKE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(env.clientId, env.clientSecret)}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token }),
  });
}

function parseTokenResponse(json: IntuitTokenResponse): QboTokens {
  const now = Date.now();
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: now + json.expires_in * 1000,
    refreshTokenExpiresAt: now + json.x_refresh_token_expires_in * 1000,
  };
}

function basicAuth(id: string, secret: string): string {
  return Buffer.from(`${id}:${secret}`).toString('base64');
}
