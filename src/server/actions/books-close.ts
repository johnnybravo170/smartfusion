'use server';

/**
 * Period-close actions: set and clear `tenants.books_closed_through`.
 *
 * Who can touch this: owners, admins, and bookkeepers. Workers can't
 * see the setting so there's no path for them to call these anyway.
 *
 * Philosophy: this is a guardrail, not an access-control wall. A
 * bookkeeper sets the close date after filing a return; the operator
 * then can't accidentally nudge a prior-period expense. Unlocking is
 * intentionally cheap (single server action) because the common case
 * is "oh, I need to add one forgotten receipt to last quarter" —
 * unlock, add it, close again.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

export type BooksCloseResult = { ok: true } | { ok: false; error: string };

const ROLES_ALLOWED = new Set(['owner', 'admin', 'bookkeeper']);

const schema = z.object({
  through: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
});

export async function setBooksClosedThroughAction(input: {
  through: string | null;
}): Promise<BooksCloseResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  if (!ROLES_ALLOWED.has(tenant.member.role)) {
    return { ok: false, error: 'Only owners, admins, and bookkeepers can close books.' };
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid date.' };

  const admin = createAdminClient();
  const { error } = await admin
    .from('tenants')
    .update({ books_closed_through: parsed.data.through, updated_at: new Date().toISOString() })
    .eq('id', tenant.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/bk');
  revalidatePath('/bk/exports');
  revalidatePath('/expenses');
  return { ok: true };
}
