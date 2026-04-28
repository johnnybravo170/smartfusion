'use server';

/**
 * Server actions for member_reminders.
 *
 * Members can manage their own reminders inside their active tenant. RLS in
 * migration 0144 enforces per-member scoping; the action layer validates
 * input shape and surfaces friendly errors.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type ReminderKind = 'daily_logging' | 'weekly_review';

const upsertSchema = z.object({
  kind: z.enum(['daily_logging', 'weekly_review']),
  localTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Time must be HH:MM (24h)'),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1, 'Pick at least one day'),
  enabled: z.boolean(),
});

export type ReminderActionResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export async function upsertReminderAction(
  input: Record<string, unknown>,
): Promise<ReminderActionResult> {
  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase.from('member_reminders').upsert(
    {
      tenant_id: tenant.id,
      tenant_member_id: tenant.member.id,
      kind: parsed.data.kind,
      local_time: parsed.data.localTime,
      days_of_week: parsed.data.daysOfWeek,
      enabled: parsed.data.enabled,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tenant_member_id,kind' },
  );

  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/reminders');
  return { ok: true };
}

export async function toggleReminderAction(input: {
  kind: ReminderKind;
  enabled: boolean;
}): Promise<ReminderActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('member_reminders')
    .update({ enabled: input.enabled, updated_at: new Date().toISOString() })
    .eq('tenant_member_id', tenant.member.id)
    .eq('kind', input.kind);

  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/reminders');
  return { ok: true };
}
