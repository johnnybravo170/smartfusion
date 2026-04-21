import { createAdminClient } from '@/lib/supabase/admin';

export type WorkerProfileRow = {
  id: string;
  tenant_id: string;
  tenant_member_id: string;
  worker_type: 'employee' | 'subcontractor';
  display_name: string | null;
  phone: string | null;
  business_name: string | null;
  gst_number: string | null;
  address: string | null;
  default_hourly_rate_cents: number | null;
  default_charge_rate_cents: number | null;
  can_log_expenses: boolean | null;
  can_invoice: boolean | null;
  nudge_email: boolean;
  nudge_sms: boolean;
  created_at: string;
  updated_at: string;
};

const COLUMNS =
  'id, tenant_id, tenant_member_id, worker_type, display_name, phone, business_name, gst_number, address, default_hourly_rate_cents, default_charge_rate_cents, can_log_expenses, can_invoice, nudge_email, nudge_sms, created_at, updated_at';

/** Get a worker's profile by tenant_member id. Auto-creates on first read. */
export async function getOrCreateWorkerProfile(
  tenantId: string,
  tenantMemberId: string,
): Promise<WorkerProfileRow> {
  const admin = createAdminClient();
  const { data: existing } = await admin
    .from('worker_profiles')
    .select(COLUMNS)
    .eq('tenant_member_id', tenantMemberId)
    .maybeSingle();

  if (existing) return existing as WorkerProfileRow;

  const { data: created, error } = await admin
    .from('worker_profiles')
    .insert({ tenant_id: tenantId, tenant_member_id: tenantMemberId })
    .select(COLUMNS)
    .single();

  if (error || !created) throw new Error(error?.message ?? 'Failed to create worker profile.');
  return created as WorkerProfileRow;
}

export async function listWorkerProfiles(tenantId: string): Promise<WorkerProfileRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('worker_profiles')
    .select(COLUMNS)
    .eq('tenant_id', tenantId);
  if (error) throw new Error(error.message);
  return (data ?? []) as WorkerProfileRow[];
}

export type WorkerProfileUpdate = Partial<{
  display_name: string | null;
  phone: string | null;
  business_name: string | null;
  gst_number: string | null;
  address: string | null;
  default_hourly_rate_cents: number | null;
  default_charge_rate_cents: number | null;
  worker_type: 'employee' | 'subcontractor';
  can_log_expenses: boolean | null;
  can_invoice: boolean | null;
  nudge_email: boolean;
  nudge_sms: boolean;
}>;

export async function updateWorkerProfile(
  tenantId: string,
  profileId: string,
  patch: WorkerProfileUpdate,
): Promise<WorkerProfileRow> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('worker_profiles')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', profileId)
    .eq('tenant_id', tenantId)
    .select(COLUMNS)
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Failed to update worker profile.');
  return data as WorkerProfileRow;
}
