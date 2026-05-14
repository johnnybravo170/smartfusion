'use server';

/**
 * Tenant deletion (PIPEDA / GDPR right to erasure).
 *
 * Two actions:
 *   - requestTenantDeletionAction: owner types business name, passes MFA;
 *     we mark tenants.deleted_at = now() and create a tenant_deletion_requests
 *     row with effective_at = now() + 30 days. Within the 30-day window the
 *     dashboard layout redirects every page to /account/deletion-pending,
 *     where the owner can abort.
 *   - abortTenantDeletionAction: clears tenants.deleted_at, sets aborted_at
 *     on the active request row.
 *
 * Hard-delete after the 30-day window is deferred — a future cron will
 * do the cascade purge. Until that ships, platform admin can manually
 * hard-delete via the Supabase dashboard.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { guardMfaForSensitiveAction } from '@/lib/auth/mfa-enforcement';
import { createAdminClient } from '@/lib/supabase/admin';

const RETENTION_DAYS = 30;

export type TenantDeletionResult =
  | { ok: true; effectiveAt: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

const requestSchema = z.object({
  confirmBusinessName: z.string().trim().min(1),
  reason: z.string().trim().max(1000).optional(),
});

export async function requestTenantDeletionAction(input: {
  confirmBusinessName: string;
  reason?: string;
}): Promise<TenantDeletionResult> {
  const block = await guardMfaForSensitiveAction();
  if (block) return { ok: false, error: block.error };

  const tenant = await getCurrentTenant();
  const user = await getCurrentUser();
  if (!tenant || !user) return { ok: false, error: 'Not signed in.' };

  if (tenant.member.role !== 'owner') {
    return { ok: false, error: 'Only the account owner can delete the workspace.' };
  }

  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please confirm the business name to delete.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  if (parsed.data.confirmBusinessName.toLowerCase() !== tenant.name.trim().toLowerCase()) {
    return {
      ok: false,
      error: `Type "${tenant.name}" exactly to confirm.`,
      fieldErrors: { confirmBusinessName: ['Business name does not match.'] },
    };
  }

  const admin = createAdminClient();
  const now = new Date();
  const effectiveAt = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { error: tenantErr } = await admin
    .from('tenants')
    .update({ deleted_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', tenant.id);
  if (tenantErr) {
    return { ok: false, error: tenantErr.message };
  }

  const { error: reqErr } = await admin.from('tenant_deletion_requests').insert({
    tenant_id: tenant.id,
    requested_by_user_id: user.id,
    reason: parsed.data.reason ?? null,
    effective_at: effectiveAt,
  });
  if (reqErr) {
    await admin
      .from('tenants')
      .update({ deleted_at: null, updated_at: now.toISOString() })
      .eq('id', tenant.id);
    return { ok: false, error: reqErr.message };
  }

  await admin
    .from('audit_log')
    .insert({
      tenant_id: tenant.id,
      user_id: user.id,
      action: 'tenant.deletion_requested',
      resource_type: 'tenant',
      resource_id: tenant.id,
      metadata_json: {
        effective_at: effectiveAt,
        retention_days: RETENTION_DAYS,
        has_reason: !!parsed.data.reason,
      },
    })
    .then(({ error }) => {
      if (error) console.warn('[tenant-deletion] audit log failed:', error.message);
    });

  revalidatePath('/');
  return { ok: true, effectiveAt };
}

export async function abortTenantDeletionAction(): Promise<TenantDeletionResult> {
  const block = await guardMfaForSensitiveAction();
  if (block) return { ok: false, error: block.error };

  const tenant = await getCurrentTenant();
  const user = await getCurrentUser();
  if (!tenant || !user) return { ok: false, error: 'Not signed in.' };

  if (tenant.member.role !== 'owner') {
    return { ok: false, error: 'Only the account owner can cancel deletion.' };
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();

  const { data: request, error: reqErr } = await admin
    .from('tenant_deletion_requests')
    .update({ aborted_at: now, aborted_by_user_id: user.id })
    .eq('tenant_id', tenant.id)
    .is('aborted_at', null)
    .select('id, effective_at')
    .maybeSingle();

  if (reqErr || !request) {
    return { ok: false, error: 'No active deletion request found.' };
  }

  const { error: tenantErr } = await admin
    .from('tenants')
    .update({ deleted_at: null, updated_at: now })
    .eq('id', tenant.id);
  if (tenantErr) {
    return { ok: false, error: tenantErr.message };
  }

  await admin
    .from('audit_log')
    .insert({
      tenant_id: tenant.id,
      user_id: user.id,
      action: 'tenant.deletion_aborted',
      resource_type: 'tenant',
      resource_id: tenant.id,
      metadata_json: {
        request_id: request.id,
        would_have_been_effective_at: request.effective_at,
      },
    })
    .then(({ error }) => {
      if (error) console.warn('[tenant-deletion] audit log failed:', error.message);
    });

  revalidatePath('/');
  return { ok: true, effectiveAt: request.effective_at as string };
}
