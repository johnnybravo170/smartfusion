/**
 * Build the From header for a tenant-originated email.
 *
 * Display name = tenant.name (fallback: "Hey Henry").
 * Address      = noreply@tenants.heyhenry.io (the platform-verified
 *                sending address on the tenant-originated subdomain).
 *                We do NOT send from tenant.contact_email because we're
 *                not DKIM-authorized on arbitrary tenant domains.
 * Reply-To     = tenant.contact_email when set (so customer replies land
 *                in the operator's inbox), else undefined.
 *
 * The resulting header looks like:
 *   From:     "Jon's Amazing Service" <noreply@tenants.heyhenry.io>
 *   Reply-To: jon@jonsamazingservice.com
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { FROM_EMAIL_TENANTS_ADDR } from './client';

export type TenantFromHeader = {
  from: string;
  replyTo: string | undefined;
};

// Pull the bare sender address out of whatever the constant contains —
// either a bare email or the "Name <addr>" form. We always override the
// display name with the tenant's name; we just need the address part.
function senderAddress(): string {
  const raw = FROM_EMAIL_TENANTS_ADDR;
  const match = raw.match(/<([^>]+)>/);
  return match ? match[1] : raw;
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '')}" <${senderAddress()}>`;
}

/**
 * Resolve the From header for a given tenant. Pulls name + contact_email
 * from the tenants table via the admin client (this runs in server actions,
 * which may or may not carry a user session).
 */
export async function getTenantFromHeader(tenantId: string): Promise<TenantFromHeader> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('tenants')
    .select('name, contact_email')
    .eq('id', tenantId)
    .maybeSingle();
  const name = ((data?.name as string | undefined) ?? 'Hey Henry').trim();
  const replyTo = (data?.contact_email as string | null | undefined)?.trim() || undefined;
  return {
    from: quote(name),
    replyTo,
  };
}
