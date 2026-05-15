/**
 * Resolve an inbound email's recipient to a tenant via
 * `tenant_inbound_addresses`. Used by the Postmark webhook to route
 * email aliased to `hello@<tenant-domain>` (or any per-tenant
 * address) into the universal intake pipeline as a fresh lead.
 *
 * Returns `null` for any recipient that isn't a verified tenant alias.
 * The webhook falls through to the existing `henry@heyhenry.io` From-
 * based path on miss.
 */

import { createAdminClient } from '@/lib/supabase/admin';

/** Strip `Name <addr@host>` framing down to the bare address. */
function bareAddress(raw: string): string {
  const trimmed = raw.trim();
  const angle = /<([^>]+)>/.exec(trimmed);
  return (angle?.[1] ?? trimmed).trim().toLowerCase();
}

/**
 * Pull every candidate address from a Postmark-style recipient field.
 * Handles `OriginalRecipient` (single envelope address — preferred) and
 * `To` (header, may be comma-separated, may carry display names).
 */
export function extractRecipientCandidates(
  originalRecipient: string | null | undefined,
  toHeader: string | null | undefined,
): string[] {
  const out = new Set<string>();
  if (originalRecipient) out.add(bareAddress(originalRecipient));
  if (toHeader) {
    for (const part of toHeader.split(',')) {
      const addr = bareAddress(part);
      if (addr) out.add(addr);
    }
  }
  return [...out].filter((s) => s.includes('@'));
}

export type ResolvedAlias = {
  id: string;
  tenantId: string;
  address: string;
};

/**
 * Look up the first verified tenant alias among the candidate addresses.
 * Returns `null` if none match. Multiple matches across tenants is
 * impossible by schema (address UNIQUE), so first hit wins.
 */
export async function resolveRecipientToTenantAlias(
  candidates: string[],
): Promise<ResolvedAlias | null> {
  if (candidates.length === 0) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('tenant_inbound_addresses')
    .select('id, tenant_id, address')
    .in('address', candidates)
    .eq('verification_status', 'verified')
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return {
    id: data.id as string,
    tenantId: data.tenant_id as string,
    address: data.address as string,
  };
}
