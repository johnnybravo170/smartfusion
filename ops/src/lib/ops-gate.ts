import { notFound, redirect } from 'next/navigation';
import { createAdminClient, createServiceClient } from './supabase';

export type Admin = {
  userId: string;
  email: string;
  aal: 'aal1' | 'aal2';
};

/**
 * Resolve the current signed-in admin OR bounce.
 *
 * - Not signed in → redirect to /login
 * - Signed in but not in ops.admins → 404 (don't confirm ops URLs exist)
 * - Signed in + admin but AAL1 (no MFA factor satisfied this session) →
 *   redirect to /login/mfa to complete the TOTP challenge
 *
 * Returns the admin record when all three checks pass.
 */
export async function requireAdmin(): Promise<Admin> {
  const supabase = await createAdminClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const service = createServiceClient();
  const { data: admin } = await service
    .schema('ops')
    .from('admins')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!admin) notFound();

  // Assurance level: aal2 = MFA verified in this session.
  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const aal = (aalData?.currentLevel as 'aal1' | 'aal2' | null) ?? 'aal1';
  if (aal !== 'aal2') redirect('/login/mfa');

  return { userId: user.id, email: user.email ?? '', aal };
}

/** Used by (ops) layout to decide whether to render admin UI at all. */
export async function getCurrentAdmin(): Promise<Admin | null> {
  const supabase = await createAdminClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const service = createServiceClient();
  const { data: admin } = await service
    .schema('ops')
    .from('admins')
    .select('user_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!admin) return null;

  const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const aal = (aalData?.currentLevel as 'aal1' | 'aal2' | null) ?? 'aal1';
  return { userId: user.id, email: user.email ?? '', aal };
}
