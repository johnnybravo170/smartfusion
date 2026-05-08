'use server';

/**
 * Portal-related tenant + project settings.
 *
 * Phase 1 of the portal-budget-visibility feature: tenant default +
 * per-project override for whether the customer portal renders the
 * per-bucket spending breakdown (`PortalBudgetDetail`). Two columns
 * (migration 0201) — `tenants.portal_show_budget` (default false) and
 * `projects.portal_show_budget` (nullable, project value wins when
 * non-null).
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type PortalSettingsResult = { ok: true } | { ok: false; error: string };

export async function updateTenantPortalShowBudgetAction(
  portalShowBudget: boolean,
): Promise<PortalSettingsResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('tenants')
    .update({ portal_show_budget: portalShowBudget })
    .eq('id', tenant.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/profile');
  return { ok: true };
}

/**
 * Tenant-level toggle for the customer schedule-update notification.
 * When ON, edits to client_visible=true schedule tasks fire a deferred
 * customer ping debounced at the project level (see
 * src/server/actions/project-schedule.ts and
 * src/app/api/cron/portal-schedule-notify). Default OFF — opt-in.
 */
export async function updateTenantNotifyOnScheduleChangeAction(
  enabled: boolean,
): Promise<PortalSettingsResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('tenants')
    .update({ notify_customer_on_schedule_change: enabled })
    .eq('id', tenant.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/profile');
  return { ok: true };
}

export async function updateProjectPortalShowBudgetAction(input: {
  projectId: string;
  /** `null` = inherit tenant default. `true` / `false` = explicit override. */
  value: boolean | null;
}): Promise<PortalSettingsResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('projects')
    .update({ portal_show_budget: input.value })
    .eq('id', input.projectId);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true };
}
