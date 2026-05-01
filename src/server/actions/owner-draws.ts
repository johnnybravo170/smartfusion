'use server';

/**
 * Server actions for the owner_draws ledger (see migration 0168).
 *
 * Tenant-scoped via RLS. Returns the PATTERNS §5 result discriminant —
 * never throws for expected errors.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { OWNER_DRAW_TYPES } from '@/lib/db/schema/owner-draws';
import { createClient } from '@/lib/supabase/server';

export type OwnerDrawRow = {
  id: string;
  paid_at: string;
  amount_cents: number;
  draw_type: (typeof OWNER_DRAW_TYPES)[number];
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type OwnerDrawActionResult = { ok: true; id: string } | { ok: false; error: string };

export type OwnerDrawListResult = { ok: true; rows: OwnerDrawRow[] } | { ok: false; error: string };

const REVALIDATE_PATH = '/business-health';

// ----------------------------------------------------------------------
// list
// ----------------------------------------------------------------------

const listSchema = z.object({
  year: z.number().int().min(2000).max(2100).optional(),
});

export async function listOwnerDrawsAction(input?: {
  year?: number;
}): Promise<OwnerDrawListResult> {
  const parsed = listSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const supabase = await createClient();
  let query = supabase
    .from('owner_draws')
    .select('id, paid_at, amount_cents, draw_type, note, created_by, created_at, updated_at')
    .order('paid_at', { ascending: false })
    .order('created_at', { ascending: false });

  if (parsed.data.year !== undefined) {
    const start = `${parsed.data.year}-01-01`;
    const end = `${parsed.data.year}-12-31`;
    query = query.gte('paid_at', start).lte('paid_at', end);
  }

  const { data, error } = await query;
  if (error) return { ok: false, error: error.message };
  return { ok: true, rows: (data ?? []) as OwnerDrawRow[] };
}

// ----------------------------------------------------------------------
// create
// ----------------------------------------------------------------------

const createSchema = z.object({
  paid_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.')
    .refine((d) => {
      const today = new Date();
      const max = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
      return new Date(`${d}T00:00:00Z`) <= max;
    }, 'Date is more than 30 days in the future.'),
  amount_cents: z.coerce
    .number()
    .int('Amount must be a whole number of cents.')
    .positive('Amount must be greater than zero.'),
  draw_type: z.enum(OWNER_DRAW_TYPES),
  note: z.string().trim().max(2000).optional().or(z.literal('')),
});

export async function createOwnerDrawAction(input: {
  paid_at: string;
  amount_cents: number;
  draw_type: (typeof OWNER_DRAW_TYPES)[number];
  note?: string;
}): Promise<OwnerDrawActionResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const user = await getCurrentUser();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('owner_draws')
    .insert({
      tenant_id: tenant.id,
      paid_at: parsed.data.paid_at,
      amount_cents: parsed.data.amount_cents,
      draw_type: parsed.data.draw_type,
      note: parsed.data.note?.length ? parsed.data.note : null,
      created_by: user?.id ?? null,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to record draw.' };
  }

  revalidatePath(REVALIDATE_PATH);
  return { ok: true, id: data.id };
}

// ----------------------------------------------------------------------
// update
// ----------------------------------------------------------------------

const updateSchema = z.object({
  id: z.string().uuid(),
  paid_at: createSchema.shape.paid_at.optional(),
  amount_cents: createSchema.shape.amount_cents.optional(),
  draw_type: createSchema.shape.draw_type.optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});

export async function updateOwnerDrawAction(input: {
  id: string;
  paid_at?: string;
  amount_cents?: number;
  draw_type?: (typeof OWNER_DRAW_TYPES)[number];
  note?: string | null;
}): Promise<OwnerDrawActionResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.paid_at !== undefined) patch.paid_at = parsed.data.paid_at;
  if (parsed.data.amount_cents !== undefined) patch.amount_cents = parsed.data.amount_cents;
  if (parsed.data.draw_type !== undefined) patch.draw_type = parsed.data.draw_type;
  if (parsed.data.note !== undefined) {
    patch.note = parsed.data.note && parsed.data.note.length ? parsed.data.note : null;
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('owner_draws')
    .update(patch)
    .eq('id', parsed.data.id)
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to update draw.' };
  }

  revalidatePath(REVALIDATE_PATH);
  return { ok: true, id: data.id };
}

// ----------------------------------------------------------------------
// delete
// ----------------------------------------------------------------------

export async function deleteOwnerDrawAction(id: string): Promise<OwnerDrawActionResult> {
  if (!id) return { ok: false, error: 'Missing draw id.' };

  const supabase = await createClient();
  const { error } = await supabase.from('owner_draws').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };

  revalidatePath(REVALIDATE_PATH);
  return { ok: true, id };
}
