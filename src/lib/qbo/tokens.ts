/**
 * Token storage + retrieval for a tenant's QBO connection.
 *
 * Tokens live on `tenants.qbo_*` columns (see migration
 * 20260511152123_qbo_integration_schema). Service-role reads only —
 * never SELECT these columns from a user-facing query.
 *
 * Token lifetime:
 *   - access_token : 1 hour
 *   - refresh_token: ~100 days, rotated on every refresh
 *
 * `loadValidTokens(tenantId)` returns a usable access token, refreshing
 * if we're within 5 min of expiry. If refresh fails (user revoked from
 * inside QBO, refresh token expired), we mark the tenant disconnected
 * and return null so callers can surface a reconnect banner.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { type QboTokens, refreshTokens } from './oauth';

const REFRESH_LEEWAY_MS = 5 * 60 * 1000;

export type ConnectionRow = {
  realmId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt: number | null;
  environment: 'sandbox' | 'production';
  companyName: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
};

/**
 * Read the raw connection state for a tenant. Returns null if not connected.
 */
export async function loadConnection(tenantId: string): Promise<ConnectionRow | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('tenants')
    .select(
      'qbo_realm_id, qbo_access_token, qbo_refresh_token, qbo_token_expires_at, qbo_environment, qbo_company_name, qbo_connected_at, qbo_disconnected_at',
    )
    .eq('id', tenantId)
    .single();

  if (error || !data) return null;

  const realmId = data.qbo_realm_id as string | null;
  const accessToken = data.qbo_access_token as string | null;
  const refreshToken = data.qbo_refresh_token as string | null;
  const expiresAtIso = data.qbo_token_expires_at as string | null;

  if (!realmId || !accessToken || !refreshToken || !expiresAtIso) return null;

  return {
    realmId,
    accessToken,
    refreshToken,
    expiresAt: new Date(expiresAtIso).getTime(),
    refreshTokenExpiresAt: null, // not currently persisted; refresh failures surface via /tokens/bearer
    environment: (data.qbo_environment as 'sandbox' | 'production' | null) ?? 'sandbox',
    companyName: data.qbo_company_name as string | null,
    connectedAt: data.qbo_connected_at as string | null,
    disconnectedAt: data.qbo_disconnected_at as string | null,
  };
}

/**
 * Persist tokens after the OAuth callback (or after a refresh).
 *
 * @param tenantId   HH tenant
 * @param realmId    QBO company id (only changes on reconnect to a different QBO company)
 * @param tokens     fresh token pair from Intuit
 * @param meta       optional connection metadata captured at connect time
 */
export async function saveConnection(
  tenantId: string,
  realmId: string,
  tokens: QboTokens,
  meta?: {
    environment?: 'sandbox' | 'production';
    companyName?: string;
    markConnected?: boolean;
  },
): Promise<void> {
  const supabase = createAdminClient();
  const now = new Date();

  const patch: Record<string, string | null> = {
    qbo_realm_id: realmId,
    qbo_access_token: tokens.accessToken,
    qbo_refresh_token: tokens.refreshToken,
    qbo_token_expires_at: new Date(tokens.expiresAt).toISOString(),
    qbo_disconnected_at: null,
    updated_at: now.toISOString(),
  };
  if (meta?.environment) patch.qbo_environment = meta.environment;
  if (meta?.companyName !== undefined) patch.qbo_company_name = meta.companyName;
  if (meta?.markConnected) patch.qbo_connected_at = now.toISOString();

  const { error } = await supabase.from('tenants').update(patch).eq('id', tenantId);
  if (error) {
    throw new Error(`Failed to save QBO connection: ${error.message}`);
  }
}

/**
 * Clear tokens from the tenant row. Used on disconnect and on hard
 * refresh failures (e.g. user revoked inside QBO).
 *
 * `realmId` is intentionally preserved so reconnect to the same QBO
 * company is a no-op for the bookkeeper's downstream reports.
 */
export async function clearConnection(
  tenantId: string,
  opts?: { keepRealmId?: boolean },
): Promise<void> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const patch: Record<string, string | null> = {
    qbo_access_token: null,
    qbo_refresh_token: null,
    qbo_token_expires_at: null,
    qbo_disconnected_at: now,
    updated_at: now,
  };
  if (!opts?.keepRealmId) patch.qbo_realm_id = null;
  const { error } = await supabase.from('tenants').update(patch).eq('id', tenantId);
  if (error) {
    throw new Error(`Failed to clear QBO connection: ${error.message}`);
  }
}

/**
 * Return an access token that's safe to use right now, refreshing if
 * we're within `REFRESH_LEEWAY_MS` of expiry. Returns null if the tenant
 * isn't connected, or if the refresh-token call fails (in which case
 * the connection is marked disconnected as a side effect).
 *
 * Callers should check for null and surface "QuickBooks disconnected"
 * UI rather than throwing.
 */
export async function loadValidTokens(
  tenantId: string,
): Promise<{ accessToken: string; realmId: string; environment: 'sandbox' | 'production' } | null> {
  const conn = await loadConnection(tenantId);
  if (!conn) return null;

  if (Date.now() < conn.expiresAt - REFRESH_LEEWAY_MS) {
    return {
      accessToken: conn.accessToken,
      realmId: conn.realmId,
      environment: conn.environment,
    };
  }

  try {
    const fresh = await refreshTokens(conn.refreshToken);
    await saveConnection(tenantId, conn.realmId, fresh);
    return {
      accessToken: fresh.accessToken,
      realmId: conn.realmId,
      environment: conn.environment,
    };
  } catch (err) {
    console.error('[qbo.tokens] refresh_failed', {
      tenant_id: tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
    await clearConnection(tenantId, { keepRealmId: true });
    return null;
  }
}
