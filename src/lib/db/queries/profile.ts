/**
 * Profile read queries — one for the whole tenant business profile, one
 * for the current operator's personal info on tenant_members.
 *
 * Both run through the RLS-aware server client. Callers pass the tenant id
 * resolved by getCurrentTenant().
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export type Socials = {
  instagram?: string | null;
  facebook?: string | null;
  tiktok?: string | null;
  youtube?: string | null;
  googleBusiness?: string | null;
  linkedin?: string | null;
  x?: string | null;
};

export type BusinessProfile = {
  id: string;
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  phone: string | null;
  contactEmail: string | null;
  websiteUrl: string | null;
  reviewUrl: string | null;
  logoStoragePath: string | null;
  logoSignedUrl: string | null;
  socials: Socials;
};

const PHOTOS_BUCKET = 'photos';

export async function getBusinessProfile(tenantId: string): Promise<BusinessProfile | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('tenants')
    .select(
      'id, name, address_line1, address_line2, city, province, postal_code, phone, contact_email, website_url, review_url, logo_storage_path, socials',
    )
    .eq('id', tenantId)
    .maybeSingle();
  if (error || !data) return null;

  const logoPath = (data.logo_storage_path as string | null) ?? null;
  let logoSignedUrl: string | null = null;
  if (logoPath) {
    const { data: signed } = await supabase.storage
      .from(PHOTOS_BUCKET)
      .createSignedUrl(logoPath, 60 * 60);
    logoSignedUrl = signed?.signedUrl ?? null;
  }

  return {
    id: data.id as string,
    name: data.name as string,
    addressLine1: (data.address_line1 as string | null) ?? null,
    addressLine2: (data.address_line2 as string | null) ?? null,
    city: (data.city as string | null) ?? null,
    province: (data.province as string | null) ?? null,
    postalCode: (data.postal_code as string | null) ?? null,
    phone: (data.phone as string | null) ?? null,
    contactEmail: (data.contact_email as string | null) ?? null,
    websiteUrl: (data.website_url as string | null) ?? null,
    reviewUrl: (data.review_url as string | null) ?? null,
    logoStoragePath: logoPath,
    logoSignedUrl,
    socials: (data.socials as Socials) ?? {},
  };
}

export type OperatorProfile = {
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  role: string;
  email: string | null;
};

export async function getOperatorProfile(
  tenantId: string,
  userId: string,
): Promise<OperatorProfile | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('tenant_members')
    .select('first_name, last_name, title, role')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return {
    firstName: (data.first_name as string | null) ?? null,
    lastName: (data.last_name as string | null) ?? null,
    title: (data.title as string | null) ?? null,
    role: data.role as string,
    email: user?.email ?? null,
  };
}

/**
 * Admin-client version for server-side flows that run outside a user session
 * (cron-driven closeout, event handlers). Returns the same shape as
 * `getBusinessProfile` but signs the logo URL for longer and uses the
 * service role.
 */
export async function getBusinessProfileAdmin(
  tenantId: string,
  logoTtlSeconds = 60 * 60 * 24 * 7,
): Promise<BusinessProfile | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('tenants')
    .select(
      'id, name, address_line1, address_line2, city, province, postal_code, phone, contact_email, website_url, review_url, logo_storage_path, socials',
    )
    .eq('id', tenantId)
    .maybeSingle();
  if (error || !data) return null;

  const logoPath = (data.logo_storage_path as string | null) ?? null;
  let logoSignedUrl: string | null = null;
  if (logoPath) {
    const { data: signed } = await admin.storage
      .from(PHOTOS_BUCKET)
      .createSignedUrl(logoPath, logoTtlSeconds);
    logoSignedUrl = signed?.signedUrl ?? null;
  }

  return {
    id: data.id as string,
    name: data.name as string,
    addressLine1: (data.address_line1 as string | null) ?? null,
    addressLine2: (data.address_line2 as string | null) ?? null,
    city: (data.city as string | null) ?? null,
    province: (data.province as string | null) ?? null,
    postalCode: (data.postal_code as string | null) ?? null,
    phone: (data.phone as string | null) ?? null,
    contactEmail: (data.contact_email as string | null) ?? null,
    websiteUrl: (data.website_url as string | null) ?? null,
    reviewUrl: (data.review_url as string | null) ?? null,
    logoStoragePath: logoPath,
    logoSignedUrl,
    socials: (data.socials as Socials) ?? {},
  };
}

/**
 * Lookup the first owner/admin member's display name for a tenant — used
 * as the default operator signoff in system-emitted emails like the
 * closeout loop. Preference order: owner → admin → first member with a
 * non-empty first_name.
 */
export async function getPrimaryOperatorName(tenantId: string): Promise<{
  firstName: string | null;
  lastName: string | null;
  title: string | null;
}> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('tenant_members')
    .select('role, first_name, last_name, title, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });
  const members = (data ?? []) as Array<{
    role: string;
    first_name: string | null;
    last_name: string | null;
    title: string | null;
  }>;

  const pick =
    members.find((m) => m.role === 'owner' && m.first_name) ??
    members.find((m) => m.role === 'admin' && m.first_name) ??
    members.find((m) => m.first_name) ??
    null;
  return {
    firstName: pick?.first_name ?? null,
    lastName: pick?.last_name ?? null,
    title: pick?.title ?? null,
  };
}
