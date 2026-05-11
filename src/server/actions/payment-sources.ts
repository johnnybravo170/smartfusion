'use server';

/**
 * Payment-source CRUD — the catalog the receipt forms pick from.
 *
 * Most rows are seeded by `seed_default_payment_sources` on signup
 * (Business / Personal-reimbursable / Petty cash). Card-based sources
 * (e.g. "Business Visa", "Personal debit") get added inline from the
 * bulk receipt wizard the first time an unrecognized last4 shows up —
 * `upsertCard` is the thin entry point for that.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import {
  listPaymentSources,
  type PaymentSourceKind,
  type PaymentSourceLite,
  type PaymentSourcePaidBy,
  type PaymentSourceRow,
  toLite,
} from '@/lib/db/queries/payment-sources';
import { createAdminClient } from '@/lib/supabase/admin';

/** Thin server-action wrapper for the picker UI in receipt forms that
 *  aren't server-rendered with the catalog already in props (header
 *  quick-log dialog, worker expense form). */
export async function listPaymentSourcesAction(): Promise<
  { ok: true; sources: PaymentSourceLite[] } | { ok: false; error: string }
> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  try {
    const rows = await listPaymentSources();
    return { ok: true, sources: toLite(rows) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to load.' };
  }
}

type Result =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

const KIND_VALUES = ['debit', 'credit', 'cash', 'etransfer', 'cheque', 'other'] as const;
const PAID_BY_VALUES = ['business', 'personal_reimbursable', 'petty_cash'] as const;
const NETWORK_VALUES = ['visa', 'mastercard', 'amex', 'interac', 'discover', 'other'] as const;

const upsertSchema = z.object({
  label: z.string().trim().min(1, 'Label is required.').max(80),
  last4: z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'Last 4 must be exactly 4 digits.')
    .nullish()
    .or(z.literal('').transform(() => null)),
  network: z.enum(NETWORK_VALUES).nullish(),
  kind: z.enum(KIND_VALUES),
  paid_by: z.enum(PAID_BY_VALUES),
  default_account_code: z.string().trim().max(40).nullish(),
});

export type UpsertPaymentSourceInput = z.input<typeof upsertSchema>;

export async function createPaymentSourceAction(input: UpsertPaymentSourceInput): Promise<Result> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('payment_sources')
    .insert({
      tenant_id: tenant.id,
      label: parsed.data.label,
      last4: parsed.data.last4 ?? null,
      network: parsed.data.network ?? null,
      kind: parsed.data.kind,
      paid_by: parsed.data.paid_by,
      default_account_code: parsed.data.default_account_code?.trim() || null,
    })
    .select('id')
    .single();

  if (error || !data) {
    // 23505 unique violation — friendlier message.
    if (error?.code === '23505') {
      const msg = parsed.data.last4
        ? `That card (****${parsed.data.last4}) is already registered.`
        : `A source labeled "${parsed.data.label}" already exists.`;
      return { ok: false, error: msg };
    }
    return { ok: false, error: error?.message ?? 'Could not create source.' };
  }

  revalidatePath('/settings/payment-sources');
  revalidatePath('/expenses');
  revalidatePath('/expenses/import');
  return { ok: true, id: data.id as string };
}

export async function updatePaymentSourceAction(
  input: UpsertPaymentSourceInput & { id: string },
): Promise<Result> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from('payment_sources')
    .update({
      label: parsed.data.label,
      last4: parsed.data.last4 ?? null,
      network: parsed.data.network ?? null,
      kind: parsed.data.kind,
      paid_by: parsed.data.paid_by,
      default_account_code: parsed.data.default_account_code?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.id)
    .eq('tenant_id', tenant.id);

  if (error) {
    if (error.code === '23505') {
      return { ok: false, error: 'A source with that label or card last 4 already exists.' };
    }
    return { ok: false, error: error.message };
  }
  revalidatePath('/settings/payment-sources');
  revalidatePath('/expenses');
  return { ok: true, id: input.id };
}

/**
 * Archive (soft-delete). Keeps the FK on historical expenses intact.
 * If the source was the tenant default, the caller must pick a new
 * default first — we refuse the archive otherwise so we never end up
 * with a tenant that has no default.
 */
export async function archivePaymentSourceAction(input: {
  id: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from('payment_sources')
    .select('id, is_default')
    .eq('id', input.id)
    .eq('tenant_id', tenant.id)
    .single();
  if (!existing) return { ok: false, error: 'Source not found.' };
  if (existing.is_default) {
    return {
      ok: false,
      error: 'Pick a different default source before archiving this one.',
    };
  }

  const { error } = await admin
    .from('payment_sources')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', input.id)
    .eq('tenant_id', tenant.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/payment-sources');
  return { ok: true };
}

export async function setDefaultPaymentSourceAction(input: {
  id: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const admin = createAdminClient();
  // Two writes in sequence: clear the existing default, set the new one.
  // The partial unique index enforces "at most one default", so we MUST
  // clear before setting — otherwise the second update collides.
  const { error: clearErr } = await admin
    .from('payment_sources')
    .update({ is_default: false, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenant.id)
    .eq('is_default', true);
  if (clearErr) return { ok: false, error: clearErr.message };

  const { error: setErr } = await admin
    .from('payment_sources')
    .update({ is_default: true, updated_at: new Date().toISOString() })
    .eq('id', input.id)
    .eq('tenant_id', tenant.id);
  if (setErr) return { ok: false, error: setErr.message };

  revalidatePath('/settings/payment-sources');
  revalidatePath('/expenses');
  return { ok: true };
}

/**
 * Used by the bulk-receipt wizard: when the operator clicks "Label this
 * card" on a row with last4=1234 and inputs (label, kind, paid_by),
 * upsert by (tenant_id, last4). If a row already exists for that last4,
 * we update its label/kind/paid_by — assume the operator is correcting
 * a typo, not creating a duplicate. Returns the resolved id.
 */
const labelCardSchema = z.object({
  last4: z.string().regex(/^\d{4}$/, 'Last 4 must be 4 digits.'),
  label: z.string().trim().min(1).max(80),
  kind: z.enum(KIND_VALUES),
  paid_by: z.enum(PAID_BY_VALUES),
  network: z.enum(NETWORK_VALUES).nullish(),
});

export type LabelCardInput = z.input<typeof labelCardSchema>;

export async function labelCardAction(
  input: LabelCardInput,
): Promise<{ ok: true; source: PaymentSourceRow } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = labelCardSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const admin = createAdminClient();

  // Look for an existing active row with the same last4. If found,
  // update; otherwise insert. Sequential is fine — at most one row per
  // tenant+last4 thanks to the partial unique index.
  const { data: existing } = await admin
    .from('payment_sources')
    .select('id')
    .eq('tenant_id', tenant.id)
    .eq('last4', parsed.data.last4)
    .is('archived_at', null)
    .maybeSingle();

  if (existing) {
    const { data, error } = await admin
      .from('payment_sources')
      .update({
        label: parsed.data.label,
        kind: parsed.data.kind,
        paid_by: parsed.data.paid_by,
        network: parsed.data.network ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id as string)
      .select('*')
      .single();
    if (error || !data) return { ok: false, error: error?.message ?? 'Update failed.' };
    revalidatePath('/settings/payment-sources');
    return { ok: true, source: data as PaymentSourceRow };
  }

  const { data, error } = await admin
    .from('payment_sources')
    .insert({
      tenant_id: tenant.id,
      label: parsed.data.label,
      last4: parsed.data.last4,
      network: parsed.data.network ?? null,
      kind: parsed.data.kind as PaymentSourceKind,
      paid_by: parsed.data.paid_by as PaymentSourcePaidBy,
    })
    .select('*')
    .single();
  if (error || !data) {
    if (error?.code === '23505') {
      return { ok: false, error: `A source labeled "${parsed.data.label}" already exists.` };
    }
    return { ok: false, error: error?.message ?? 'Could not save card.' };
  }

  revalidatePath('/settings/payment-sources');
  return { ok: true, source: data as PaymentSourceRow };
}
