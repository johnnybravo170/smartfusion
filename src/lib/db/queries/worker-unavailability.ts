import { createAdminClient } from '@/lib/supabase/admin';

export type ReasonTag = 'vacation' | 'sick' | 'other_job' | 'personal' | 'other';

export type UnavailabilityRow = {
  id: string;
  worker_profile_id: string;
  unavailable_date: string;
  reason_tag: ReasonTag;
  reason_text: string | null;
};

const COLUMNS = 'id, worker_profile_id, unavailable_date, reason_tag, reason_text';

export async function listUnavailabilityForWorker(
  tenantId: string,
  workerProfileId: string,
  from: string,
  to: string,
): Promise<UnavailabilityRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('worker_unavailability')
    .select(COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('worker_profile_id', workerProfileId)
    .gte('unavailable_date', from)
    .lte('unavailable_date', to)
    .order('unavailable_date', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as UnavailabilityRow[];
}

export async function listUnavailabilityForTenant(
  tenantId: string,
  from: string,
  to: string,
): Promise<UnavailabilityRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('worker_unavailability')
    .select(COLUMNS)
    .eq('tenant_id', tenantId)
    .gte('unavailable_date', from)
    .lte('unavailable_date', to)
    .order('unavailable_date', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as UnavailabilityRow[];
}

export const REASON_LABELS: Record<ReasonTag, string> = {
  vacation: 'Vacation',
  sick: 'Sick',
  other_job: 'Other job',
  personal: 'Personal',
  other: 'Other',
};
