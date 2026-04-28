/**
 * Read-side helpers for member_reminders. Pulls the caller's reminders
 * scoped to their active tenant_member.
 */

import { createClient } from '@/lib/supabase/server';
import type { ReminderKind } from '@/server/actions/reminders';

export type MemberReminder = {
  id: string;
  kind: ReminderKind;
  localTime: string;
  daysOfWeek: number[];
  channel: 'sms' | 'email' | 'push';
  enabled: boolean;
  lastSentAt: string | null;
};

export async function listMyReminders(tenantMemberId: string): Promise<MemberReminder[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('member_reminders')
    .select('id, kind, local_time, days_of_week, channel, enabled, last_sent_at')
    .eq('tenant_member_id', tenantMemberId);
  if (error || !data) return [];
  return data.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: row.id as string,
      kind: row.kind as ReminderKind,
      localTime: row.local_time as string,
      daysOfWeek: (row.days_of_week as number[]) ?? [],
      channel: row.channel as 'sms' | 'email' | 'push',
      enabled: !!row.enabled,
      lastSentAt: (row.last_sent_at as string | null) ?? null,
    };
  });
}
