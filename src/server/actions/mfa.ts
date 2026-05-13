'use server';

/**
 * MFA (TOTP) server actions — enrollment, verification, recovery codes.
 *
 * Phase 1 of MFA_PLAN.md: voluntary enrollment from Settings → Security.
 * No enforcement, no login-challenge flow yet. Owners can opt in.
 *
 * TOTP factor storage is handled by Supabase (`auth.mfa_factors`). We add
 * recovery codes on top in `user_recovery_codes` since Supabase doesn't
 * issue those. Codes are sha256-hashed at rest; plaintext is returned to
 * the user exactly once at enrollment and on regeneration.
 *
 * Action shape follows PATTERNS.md §5: `{ ok: true; ...data } | { ok: false; error }`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { audit } from '@/lib/audit';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const ISSUER = 'HeyHenry';
const RECOVERY_CODE_COUNT = 10;

export type MfaActionResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

type TotpEnrollData = {
  factorId: string;
  qrCodeSvg: string;
  secret: string;
};

type VerifyEnrollmentData = {
  recoveryCodes: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate one recovery code in the format `abcd-ef12-3456` (12 hex chars,
 * 48 bits of entropy, grouped for readability).
 */
function generateRecoveryCode(): string {
  const hex = randomBytes(6).toString('hex');
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}

/**
 * Replace all existing recovery codes for a user with a fresh set of
 * `RECOVERY_CODE_COUNT` codes. Returns the plaintext codes (only chance
 * the user has to see them).
 */
async function replaceRecoveryCodes(userId: string): Promise<string[]> {
  const admin = createAdminClient();

  // Hard-delete previous codes. A regenerated set invalidates everything
  // that came before, used or not.
  await admin.from('user_recovery_codes').delete().eq('user_id', userId);

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const rows = codes.map((code) => ({ user_id: userId, code_hash: hashCode(code) }));

  const { error } = await admin.from('user_recovery_codes').insert(rows);
  if (error) throw new Error(`Failed to store recovery codes: ${error.message}`);

  return codes;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Start TOTP enrollment. Creates an unverified factor and returns the QR
 * code + secret so the user can add it to their authenticator app. The
 * factor stays unverified until `verifyMfaEnrollmentAction` succeeds.
 *
 * Safe to call repeatedly: an orphaned unverified factor from a previous
 * attempt is cleaned up first.
 */
export async function startMfaEnrollmentAction(): Promise<MfaActionResult<TotpEnrollData>> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  // Clean up any leftover unverified TOTP factor from a prior attempt.
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const leftover = factors?.all?.find((f) => f.factor_type === 'totp' && f.status === 'unverified');
  if (leftover) {
    await supabase.auth.mfa.unenroll({ factorId: leftover.id });
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: `HeyHenry (${new Date().toISOString().slice(0, 10)})`,
    issuer: ISSUER,
  });
  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Could not start enrollment.' };
  }

  return {
    ok: true,
    factorId: data.id,
    qrCodeSvg: data.totp.qr_code,
    secret: data.totp.secret,
  };
}

/**
 * Verify the 6-digit code the user typed from their authenticator app.
 * On success the factor moves to `verified`, the session is upgraded to
 * `aal2`, and a fresh set of recovery codes is generated and returned
 * (plaintext — shown once, never again).
 */
export async function verifyMfaEnrollmentAction(input: {
  factorId: string;
  code: string;
}): Promise<MfaActionResult<VerifyEnrollmentData>> {
  const factorId = String(input.factorId ?? '').trim();
  const code = String(input.code ?? '').trim();

  if (!factorId) return { ok: false, error: 'Missing factor.' };
  if (!/^\d{6}$/.test(code)) return { ok: false, error: 'Enter the 6-digit code.' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId });
  if (challengeErr || !challenge) {
    return { ok: false, error: challengeErr?.message ?? 'Could not create challenge.' };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code,
  });
  if (verifyErr) {
    return { ok: false, error: verifyErr.message };
  }

  let recoveryCodes: string[];
  try {
    recoveryCodes = await replaceRecoveryCodes(user.id);
  } catch (err) {
    // Factor is verified but we failed to issue codes — surface the error.
    // The user can hit "Regenerate codes" from Settings → Security to retry.
    const msg = err instanceof Error ? err.message : 'Could not generate recovery codes.';
    return { ok: false, error: msg };
  }

  return { ok: true, recoveryCodes };
}

/**
 * Regenerate recovery codes. Requires a valid current TOTP code (proof
 * of possession) so a stolen session can't quietly swap the codes out.
 * All previously-issued codes are invalidated.
 */
export async function regenerateRecoveryCodesAction(input: {
  code: string;
}): Promise<MfaActionResult<VerifyEnrollmentData>> {
  const code = String(input.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, error: 'Enter the 6-digit code.' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { data: factors } = await supabase.auth.mfa.listFactors();
  const totp = factors?.totp?.find((f) => f.status === 'verified');
  if (!totp) return { ok: false, error: 'No verified authenticator found.' };

  const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
    factorId: totp.id,
  });
  if (challengeErr || !challenge) {
    return { ok: false, error: challengeErr?.message ?? 'Could not create challenge.' };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId: totp.id,
    challengeId: challenge.id,
    code,
  });
  if (verifyErr) return { ok: false, error: verifyErr.message };

  try {
    const recoveryCodes = await replaceRecoveryCodes(user.id);
    return { ok: true, recoveryCodes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Could not regenerate codes.';
    return { ok: false, error: msg };
  }
}

/**
 * Remove the user's TOTP factor and wipe their recovery codes. Requires a
 * valid current TOTP code to confirm the user is still in possession of
 * the authenticator.
 */
export async function unenrollMfaAction(input: { code: string }): Promise<MfaActionResult> {
  const code = String(input.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, error: 'Enter the 6-digit code.' };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const { data: factors } = await supabase.auth.mfa.listFactors();
  const totp = factors?.totp?.find((f) => f.status === 'verified');
  if (!totp) return { ok: false, error: 'No verified authenticator found.' };

  const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({
    factorId: totp.id,
  });
  if (challengeErr || !challenge) {
    return { ok: false, error: challengeErr?.message ?? 'Could not create challenge.' };
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId: totp.id,
    challengeId: challenge.id,
    code,
  });
  if (verifyErr) return { ok: false, error: verifyErr.message };

  const { error: unenrollErr } = await supabase.auth.mfa.unenroll({ factorId: totp.id });
  if (unenrollErr) return { ok: false, error: unenrollErr.message };

  const admin = createAdminClient();
  await admin.from('user_recovery_codes').delete().eq('user_id', user.id);

  // Security regression — log loudly.
  const tenant = await getCurrentTenant();
  if (tenant) {
    await audit({
      tenantId: tenant.id,
      userId: user.id,
      action: 'mfa.disabled',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { factor_id: totp.id },
    });
  }

  return { ok: true };
}
