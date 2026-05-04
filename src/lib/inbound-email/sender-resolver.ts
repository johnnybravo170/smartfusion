/**
 * Resolve a forwarder's From-address header to the tenant they own/admin.
 *
 * Backed by the `resolve_inbound_sender(text)` SECURITY DEFINER RPC
 * (migration 0178), which joins auth.users → tenant_members and returns
 * the matched tenant_id, or NULL for unknown OR ambiguous senders.
 *
 * The app layer can't query auth.users directly — only Supabase's
 * paginated admin.auth.admin.listUsers() exists, which is wrong for a
 * per-request lookup. Hence the RPC.
 */

import { createAdminClient } from '@/lib/supabase/admin';

/** Strip "Display Name <addr@domain>" → "addr@domain" lowercase + trimmed. */
export function normaliseEmail(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

export async function resolveSenderToTenant(fromHeader: string): Promise<string | null> {
  const email = normaliseEmail(fromHeader);
  if (!email.includes('@')) return null;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc('resolve_inbound_sender', { p_email: email });
  if (error) {
    console.error('[sender-resolver] RPC failed', error);
    return null;
  }
  return (data as string | null) ?? null;
}
