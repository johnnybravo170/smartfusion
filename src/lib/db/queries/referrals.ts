/**
 * Referral queries that run through the RLS-aware Supabase server client
 * (except findReferralCodeByCode which uses the admin client for public access).
 */

import { generateReferralCode } from '@/lib/referral/code-generator';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export type ReferralCodeRow = {
  id: string;
  tenant_id: string;
  code: string;
  type: string;
  is_active: boolean;
  created_at: string;
};

export type ReferralRow = {
  id: string;
  referral_code_id: string;
  referrer_tenant_id: string;
  referred_tenant_id: string | null;
  referred_email: string | null;
  referred_phone: string | null;
  status: string;
  reward_status: string;
  signed_up_at: string | null;
  converted_at: string | null;
  created_at: string;
};

export type ReferralStats = {
  total: number;
  signed_up: number;
  converted: number;
};

/**
 * Get the tenant's existing referral code or create one.
 * Runs under RLS via the server client.
 */
export async function getOrCreateReferralCode(
  tenantId: string,
  tenantName: string,
): Promise<ReferralCodeRow> {
  const supabase = await createClient();

  // Check for existing code.
  const { data: existing } = await supabase
    .from('referral_codes')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('type', 'operator')
    .maybeSingle();

  if (existing) return existing as ReferralCodeRow;

  // Generate a new code. If it collides (unique constraint), append a short random suffix.
  let code = generateReferralCode(tenantName);
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    const { data: created, error } = await supabase
      .from('referral_codes')
      .insert({ tenant_id: tenantId, code, type: 'operator' })
      .select('*')
      .single();

    if (created) return created as ReferralCodeRow;

    // Unique constraint violation — try with a suffix.
    if (error?.code === '23505') {
      const suffix = Math.random().toString(36).slice(2, 6);
      code = `${generateReferralCode(tenantName)}-${suffix}`;
      attempts++;
      continue;
    }

    throw new Error(error?.message ?? 'Failed to create referral code.');
  }

  throw new Error('Could not generate a unique referral code after multiple attempts.');
}

/**
 * Get referral stats for a tenant. Runs under RLS.
 */
export async function getReferralStats(tenantId: string): Promise<ReferralStats> {
  const supabase = await createClient();

  const { data: referrals } = await supabase
    .from('referrals')
    .select('status')
    .eq('referrer_tenant_id', tenantId);

  const rows = referrals ?? [];
  return {
    total: rows.length,
    signed_up: rows.filter((r) => r.status === 'signed_up' || r.status === 'converted').length,
    converted: rows.filter((r) => r.status === 'converted').length,
  };
}

/**
 * List referral history for a tenant. Runs under RLS.
 */
export async function listReferrals(
  tenantId: string,
  { limit = 50 }: { limit?: number } = {},
): Promise<ReferralRow[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('referrals')
    .select('*')
    .eq('referrer_tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data ?? []) as ReferralRow[];
}

/**
 * Create a pending referral row. Runs under RLS.
 *
 * Provide exactly one of `referred_email` or `referred_phone` — the channel
 * used to deliver the invite. Either may be omitted; both is allowed but
 * unusual in practice.
 */
export async function createReferral(data: {
  referral_code_id: string;
  referrer_tenant_id: string;
  referred_email?: string;
  referred_phone?: string;
}): Promise<ReferralRow> {
  // Use admin client for the insert since RLS only allows SELECT on referrals.
  const admin = createAdminClient();
  const { data: created, error } = await admin.from('referrals').insert(data).select('*').single();

  if (error || !created) {
    throw new Error(error?.message ?? 'Failed to create referral.');
  }
  return created as ReferralRow;
}

/**
 * Find a referral code by its code string. Uses the admin client
 * because this is called from the public landing page (no auth).
 */
export async function findReferralCodeByCode(
  code: string,
): Promise<{ id: string; code: string; tenant_id: string; tenant_name: string } | null> {
  const admin = createAdminClient();

  const { data, error } = await admin
    .from('referral_codes')
    .select('id, code, tenant_id, tenants(name)')
    .eq('code', code)
    .eq('is_active', true)
    .maybeSingle();

  if (error || !data) return null;

  const tenant = Array.isArray(data.tenants) ? data.tenants[0] : data.tenants;
  return {
    id: data.id as string,
    code: data.code as string,
    tenant_id: data.tenant_id as string,
    tenant_name: (tenant as { name: string })?.name ?? 'A business',
  };
}

/**
 * Update a referral row when the referred user signs up.
 * Uses the admin client (called during signup, no session yet).
 */
export async function updateReferralOnSignup(code: string, newTenantId: string): Promise<void> {
  const admin = createAdminClient();

  // Find the referral code.
  const { data: refCode } = await admin
    .from('referral_codes')
    .select('id')
    .eq('code', code)
    .eq('is_active', true)
    .maybeSingle();

  if (!refCode) return;

  // Find the most recent pending referral for this code.
  const { data: referral } = await admin
    .from('referrals')
    .select('id')
    .eq('referral_code_id', refCode.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (referral) {
    await admin
      .from('referrals')
      .update({
        referred_tenant_id: newTenantId,
        status: 'signed_up',
        signed_up_at: new Date().toISOString(),
      })
      .eq('id', referral.id);
  }
}
