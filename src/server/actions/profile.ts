'use server';

/**
 * Business + operator profile server actions.
 *
 * Business fields live on `tenants`. Operator personal fields live on
 * `tenant_members`. Logo upload stores the file under the existing photos
 * bucket at `{tenant_id}/_profile/logo.{ext}` — the bucket's RLS only checks
 * the first path segment, so the same policies apply.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { normalizeProvinceCode } from '@/lib/tax/provinces';
import { normalizePhone } from '@/lib/twilio/client';
import {
  type BusinessProfileInput,
  businessProfileSchema,
  emptyToNull,
  type OperatorNameInput,
  type OperatorProfileInput,
  operatorNameSchema,
  operatorProfileSchema,
  type SocialsInput,
  socialsSchema,
} from '@/lib/validators/profile';
import { gstNumberSchema, normalizeGstNumber } from '@/lib/validators/tax-id';

export type ProfileActionResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

const PHOTOS_BUCKET = 'photos';
const LOGO_MAX_BYTES = 5 * 1024 * 1024;
const LOGO_ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);

export async function updateBusinessProfileAction(
  input: BusinessProfileInput,
): Promise<ProfileActionResult> {
  const parsed = businessProfileSchema.safeParse(input);
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
  const { error } = await supabase
    .from('tenants')
    .update({
      name: parsed.data.name,
      address_line1: emptyToNull(parsed.data.addressLine1),
      address_line2: emptyToNull(parsed.data.addressLine2),
      city: emptyToNull(parsed.data.city),
      // Normalize any stray free-text province ("British Columbia") to
      // its 2-letter code ("BC"). The province picker in the UI only
      // emits codes, but this guards against legacy values or API clients.
      province: normalizeProvinceCode(parsed.data.province) ?? null,
      postal_code: emptyToNull(parsed.data.postalCode),
      phone: emptyToNull(parsed.data.phone),
      contact_email: emptyToNull(parsed.data.contactEmail),
      website_url: emptyToNull(parsed.data.websiteUrl),
      review_url: emptyToNull(parsed.data.reviewUrl),
      gst_number: parsed.data.gstNumber?.trim() ? normalizeGstNumber(parsed.data.gstNumber) : null,
      wcb_number: emptyToNull(parsed.data.wcbNumber),
      updated_at: new Date().toISOString(),
    })
    .eq('id', tenant.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings');
  revalidatePath('/settings/profile');
  return { ok: true };
}

/**
 * Single-field update for the GST/HST number. Used by the first-send gate
 * on estimates + invoices so an operator can set their number inline
 * without leaving the send flow. Strict format validation; normalizes on
 * save.
 */
export async function setTenantGstNumberAction(gstNumber: string): Promise<ProfileActionResult> {
  const parsed = gstNumberSchema.safeParse(gstNumber);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid GST/HST number.',
    };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('tenants')
    .update({ gst_number: parsed.data, updated_at: new Date().toISOString() })
    .eq('id', tenant.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/profile');
  return { ok: true };
}

export async function updateSocialsAction(input: SocialsInput): Promise<ProfileActionResult> {
  const parsed = socialsSchema.safeParse(input);
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
  const payload: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    const normalized = emptyToNull(v ?? '');
    if (normalized !== null) payload[k] = normalized;
  }

  const { error } = await supabase
    .from('tenants')
    .update({ socials: payload, updated_at: new Date().toISOString() })
    .eq('id', tenant.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/profile');
  return { ok: true };
}

export async function updateOperatorProfileAction(
  input: OperatorProfileInput,
): Promise<ProfileActionResult> {
  const parsed = operatorProfileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const tenant = await getCurrentTenant();
  const user = await getCurrentUser();
  if (!tenant || !user) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('tenant_members')
    .update({
      first_name: emptyToNull(parsed.data.firstName),
      last_name: emptyToNull(parsed.data.lastName),
      title: emptyToNull(parsed.data.title),
      notification_phone: parsed.data.notificationPhone
        ? (normalizePhone(parsed.data.notificationPhone) ??
          emptyToNull(parsed.data.notificationPhone))
        : null,
      default_hourly_rate_cents: parsed.data.defaultHourlyRateCents ?? null,
      notify_prefs: {
        customer_feedback: {
          email: parsed.data.notifyCustomerFeedbackEmail,
          sms: parsed.data.notifyCustomerFeedbackSms,
        },
        change_order_response: {
          email: parsed.data.notifyChangeOrderResponseEmail,
          sms: parsed.data.notifyChangeOrderResponseSms,
        },
      },
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', tenant.id)
    .eq('user_id', user.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/profile');
  return { ok: true };
}

/**
 * Sets just first + last name on the current operator's tenant_members
 * row. Backs the signup catch-up prompt for existing operators whose name
 * was never populated (signup didn't require it until 2026-05). Distinct
 * from updateOperatorProfileAction so the prompt doesn't need to round-trip
 * every other profile field.
 */
export async function setOperatorNameAction(
  input: OperatorNameInput,
): Promise<ProfileActionResult> {
  const parsed = operatorNameSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const tenant = await getCurrentTenant();
  const user = await getCurrentUser();
  if (!tenant || !user) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('tenant_members')
    .update({
      first_name: parsed.data.firstName,
      last_name: parsed.data.lastName,
      updated_at: new Date().toISOString(),
    })
    .eq('tenant_id', tenant.id)
    .eq('user_id', user.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function uploadLogoAction(formData: FormData): Promise<ProfileActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No file provided.' };
  }
  if (file.size > LOGO_MAX_BYTES) {
    return { ok: false, error: 'Logo must be under 5 MB.' };
  }
  if (!LOGO_ALLOWED_MIMES.has(file.type)) {
    return { ok: false, error: 'Logo must be PNG, JPEG, WebP, or SVG.' };
  }

  const ext = fileExtension(file);
  const path = `${tenant.id}/_profile/logo.${ext}`;
  const supabase = await createClient();

  const { error: uploadErr } = await supabase.storage
    .from(PHOTOS_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (uploadErr) return { ok: false, error: uploadErr.message };

  const { error: updateErr } = await supabase
    .from('tenants')
    .update({ logo_storage_path: path, updated_at: new Date().toISOString() })
    .eq('id', tenant.id);
  if (updateErr) return { ok: false, error: updateErr.message };

  revalidatePath('/settings/profile');
  return { ok: true };
}

export async function clearLogoAction(): Promise<ProfileActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data: row } = await supabase
    .from('tenants')
    .select('logo_storage_path')
    .eq('id', tenant.id)
    .maybeSingle();
  const existing = (row?.logo_storage_path as string | null) ?? null;

  if (existing) {
    await supabase.storage.from(PHOTOS_BUCKET).remove([existing]);
  }
  const { error } = await supabase
    .from('tenants')
    .update({ logo_storage_path: null, updated_at: new Date().toISOString() })
    .eq('id', tenant.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/profile');
  return { ok: true };
}

function fileExtension(file: File): string {
  const byName = (file.name ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (/^[a-z0-9]{1,5}$/.test(byName)) return byName;
  switch (file.type) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/svg+xml':
      return 'svg';
    default:
      return 'png';
  }
}
