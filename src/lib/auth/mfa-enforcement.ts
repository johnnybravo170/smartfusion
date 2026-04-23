/**
 * MFA enforcement policy (Phase 3 of MFA_PLAN.md).
 *
 * Who must enroll:
 *   - Tenant owners: always.
 *   - Tenant admins/members: only when the tenant's
 *     `require_mfa_for_all_members` flag is true.
 *
 * Grace period:
 *   - 14 days from `tenant_members.mfa_grace_started_at`.
 *   - During grace: a banner nudges, sensitive actions still work.
 *   - After grace: sensitive actions soft-lock until the user enrolls.
 *
 * First-use semantics: `mfa_grace_started_at` is nullable. The app layer
 * sets it to now() the first time a user lands on a page that checks
 * enforcement (see `ensureMfaGraceStarted`). This way existing users get
 * a fair 14-day runway regardless of when the enforcement feature ships.
 */

import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { getMfaStatus } from '@/lib/auth/mfa';
import { createAdminClient } from '@/lib/supabase/admin';

export const MFA_GRACE_DAYS = 14;

export type MfaEnforcementSnapshot = {
  /** The user is required to enroll given their role + tenant policy. */
  required: boolean;
  /** They have completed enrollment. */
  enrolled: boolean;
  /** ISO timestamp when their grace period began (set lazily, may be null). */
  graceStartedAt: string | null;
  /** Days remaining in the grace period (0 when expired or not required). */
  graceDaysRemaining: number;
  /** Grace is expired — sensitive actions should soft-lock. */
  blocked: boolean;
};

/**
 * Returns whether a given role + tenant policy combination means MFA is
 * mandatory. Pure function — no DB or Supabase calls.
 */
export function mfaRequiredFor(params: {
  role: string;
  requireMfaForAllMembers: boolean;
}): boolean {
  if (params.role === 'owner') return true;
  if (params.requireMfaForAllMembers) return true;
  return false;
}

function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Lazily set `mfa_grace_started_at` on the member row if it's still null
 * and the user is subject to enforcement. Returns the ISO timestamp
 * currently stored (or just set).
 */
async function ensureMfaGraceStarted(params: {
  memberId: string;
  current: string | null;
}): Promise<string | null> {
  if (params.current) return params.current;

  const admin = createAdminClient();
  const now = new Date().toISOString();
  const { error } = await admin
    .from('tenant_members')
    .update({ mfa_grace_started_at: now })
    .eq('id', params.memberId)
    .is('mfa_grace_started_at', null);
  if (error) {
    // Non-fatal: if the update fails, we just won't have a grace clock
    // yet. The next page load will try again.
    console.warn('Failed to start MFA grace period:', error.message);
    return null;
  }
  return now;
}

/**
 * Full MFA enforcement snapshot for the current signed-in user. Call
 * from server components that need to render the banner or guard a
 * sensitive action. Returns null if unauthenticated or no tenant.
 */
export async function getMfaEnforcement(): Promise<MfaEnforcementSnapshot | null> {
  const [user, tenantCtx] = await Promise.all([getCurrentUser(), getCurrentTenant()]);
  if (!user || !tenantCtx) return null;

  // Need the tenant flag — getCurrentTenant doesn't carry it.
  const admin = createAdminClient();
  const { data: tenantRow } = await admin
    .from('tenants')
    .select('require_mfa_for_all_members')
    .eq('id', tenantCtx.id)
    .single();

  const requireAll = !!tenantRow?.require_mfa_for_all_members;

  const required = mfaRequiredFor({
    role: tenantCtx.member.role,
    requireMfaForAllMembers: requireAll,
  });

  const mfa = await getMfaStatus();
  const enrolled = !!mfa?.enrolled;

  if (!required || enrolled) {
    return {
      required,
      enrolled,
      graceStartedAt: null,
      graceDaysRemaining: 0,
      blocked: false,
    };
  }

  // Required but not enrolled — need to track the grace clock.
  const { data: memberRow } = await admin
    .from('tenant_members')
    .select('mfa_grace_started_at')
    .eq('id', tenantCtx.member.id)
    .single();

  const graceStartedAt = await ensureMfaGraceStarted({
    memberId: tenantCtx.member.id,
    current: (memberRow?.mfa_grace_started_at as string | null) ?? null,
  });

  const daysElapsed = graceStartedAt ? daysBetween(new Date(graceStartedAt), new Date()) : 0;
  const daysRemaining = Math.max(0, MFA_GRACE_DAYS - daysElapsed);

  return {
    required: true,
    enrolled: false,
    graceStartedAt,
    graceDaysRemaining: daysRemaining,
    blocked: daysRemaining === 0,
  };
}

/**
 * Guard for sensitive server actions. Returns `null` when the caller is
 * allowed through; returns a `{ ok: false }` result when they're blocked
 * post-grace without MFA. Spread the returned object as the action's
 * result.
 */
export async function guardMfaForSensitiveAction(): Promise<null | {
  ok: false;
  error: string;
  mfaRequired: true;
}> {
  const snap = await getMfaEnforcement();
  if (!snap) return null;
  if (!snap.blocked) return null;
  return {
    ok: false,
    error:
      'Two-factor authentication is required to perform this action. Set it up in Settings → Security.',
    mfaRequired: true,
  };
}
