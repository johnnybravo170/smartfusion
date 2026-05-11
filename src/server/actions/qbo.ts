'use server';

/**
 * Server actions for the QuickBooks Online connection lifecycle.
 *
 * `connectQboAction` is a thin wrapper around the `/api/qbo/start` route
 * — it just returns the URL the connect card should navigate to. The
 * route handler does the real OAuth work because state-cookie signing
 * + Intuit redirect are cleaner there.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { revokeToken } from '@/lib/qbo/oauth';
import { clearConnection, loadConnection } from '@/lib/qbo/tokens';

export type QboActionResult = { ok: true; url?: string } | { ok: false; error: string };

/**
 * Returns the URL the browser should navigate to in order to start the
 * Intuit OAuth flow. The actual authorize redirect happens in the route
 * handler at `/api/qbo/start` (which mints the state cookie and bounces
 * to Intuit).
 */
export async function connectQboAction(): Promise<QboActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }
  return { ok: true, url: '/api/qbo/start' };
}

/**
 * Disconnect QBO for the current tenant. Best-effort revoke at Intuit,
 * then clear local tokens. Realm id is kept so reconnect to the same
 * QBO company lands cleanly.
 */
export async function disconnectQboAction(): Promise<QboActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const conn = await loadConnection(tenant.id);
  if (conn?.refreshToken) {
    // Best-effort — Intuit returns 200 even if the token was already
    // revoked, so we don't gate the local clear on this.
    try {
      await revokeToken(conn.refreshToken);
    } catch (err) {
      console.error('[qbo.disconnect] revoke_failed', {
        tenant_id: tenant.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    await clearConnection(tenant.id, { keepRealmId: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  revalidatePath('/settings');
  return { ok: true };
}
