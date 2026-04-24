'use server';

/**
 * Server actions for the CRM module.
 *
 * All three mutations run through the RLS-aware server client so the tenant
 * check happens in the database, not application code. We still resolve the
 * tenant via `getCurrentTenant()` because INSERT needs an explicit
 * `tenant_id` (the RLS WITH CHECK makes sure it matches the caller).
 *
 * Spec: PHASE_1_PLAN.md §8 Track A.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { type ContactMatch, findContactMatches } from '@/lib/db/queries/contact-matches';
import { createClient } from '@/lib/supabase/server';
import {
  customerCreateSchema,
  customerUpdateSchema,
  emptyToNull,
  resolveKindAndSubtypeFromLegacyType,
} from '@/lib/validators/customer';

export type CustomerActionResult =
  | { ok: true; id: string }
  | {
      ok: false;
      error: string;
      fieldErrors?: Record<string, string[]>;
      /**
       * When set, the caller tried to create/update a contact whose name,
       * phone, or email matches one or more existing contacts. The form
       * should surface the matches and give the operator a choice between
       * "Use this existing" and "Create anyway" (resubmit with
       * `confirmCreate: true`).
       */
      duplicates?: ContactMatch[];
    };

export type CustomerFormInput = {
  type: string;
  /** Optional kind-first field (preferred over legacy `type` when present). */
  kind?: string;
  name: string;
  email?: string;
  phone?: string;
  addressLine1?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  notes?: string;
  /**
   * When true, skip the duplicate check. Callers set this after the operator
   * has seen the duplicates banner and explicitly chosen "Create anyway".
   */
  confirmCreate?: boolean;
};

/**
 * Resolve (kind, subtype) from whatever the form sent — either the new
 * kind-first shape (`kind` + `type` as subtype) or the legacy three-way
 * `type` value. Kind wins when both are present.
 */
function resolveKindAndSubtype(input: { type: string; kind?: string }): {
  kind: 'customer' | 'vendor' | 'sub' | 'agent' | 'inspector' | 'referral' | 'other';
  subtype: 'residential' | 'commercial' | null;
} {
  if (input.kind) {
    if (input.kind === 'customer') {
      const t = input.type === 'residential' || input.type === 'commercial' ? input.type : null;
      return { kind: 'customer', subtype: t };
    }
    return {
      kind: input.kind as 'vendor' | 'sub' | 'agent' | 'inspector' | 'referral' | 'other',
      subtype: null,
    };
  }
  return resolveKindAndSubtypeFromLegacyType(input.type as 'residential' | 'commercial' | 'agent');
}

export async function createCustomerAction(
  input: CustomerFormInput,
): Promise<CustomerActionResult> {
  const parsed = customerCreateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();
  const { kind, subtype } = resolveKindAndSubtype(parsed.data);

  // Duplicate check — skip when the form resubmitted with confirmCreate.
  if (!input.confirmCreate) {
    const duplicates = await findContactMatches({
      name: parsed.data.name,
      phone: parsed.data.phone,
      email: parsed.data.email,
    });
    if (duplicates.length > 0) {
      return {
        ok: false,
        error:
          duplicates.length === 1
            ? 'A contact like this already exists.'
            : 'Contacts like this already exist.',
        duplicates,
      };
    }
  }

  const { data, error } = await supabase
    .from('customers')
    .insert({
      tenant_id: tenant.id,
      kind,
      type: subtype,
      name: parsed.data.name,
      email: emptyToNull(parsed.data.email),
      phone: emptyToNull(parsed.data.phone),
      address_line1: emptyToNull(parsed.data.addressLine1),
      city: emptyToNull(parsed.data.city),
      province: emptyToNull(parsed.data.province),
      postal_code: emptyToNull(parsed.data.postalCode),
      notes: emptyToNull(parsed.data.notes),
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to create customer.' };
  }

  revalidatePath('/contacts');
  return { ok: true, id: data.id };
}

export async function updateCustomerAction(
  input: CustomerFormInput & { id: string },
): Promise<CustomerActionResult> {
  const parsed = customerUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = await createClient();
  const { kind, subtype } = resolveKindAndSubtype(parsed.data);

  // Duplicate check — only flag when the edit would now collide with a
  // DIFFERENT contact. Exclude the row being edited. Skip when the form
  // already confirmed.
  if (!input.confirmCreate) {
    const duplicates = await findContactMatches({
      name: parsed.data.name,
      phone: parsed.data.phone,
      email: parsed.data.email,
      excludeId: parsed.data.id,
    });
    if (duplicates.length > 0) {
      return {
        ok: false,
        error:
          duplicates.length === 1
            ? 'Another contact already has this phone / email / name.'
            : 'Other contacts already match on this phone / email / name.',
        duplicates,
      };
    }
  }

  const { error } = await supabase
    .from('customers')
    .update({
      kind,
      type: subtype,
      name: parsed.data.name,
      email: emptyToNull(parsed.data.email),
      phone: emptyToNull(parsed.data.phone),
      address_line1: emptyToNull(parsed.data.addressLine1),
      city: emptyToNull(parsed.data.city),
      province: emptyToNull(parsed.data.province),
      postal_code: emptyToNull(parsed.data.postalCode),
      notes: emptyToNull(parsed.data.notes),
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.id)
    .is('deleted_at', null);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/contacts');
  revalidatePath(`/contacts/${parsed.data.id}`);
  return { ok: true, id: parsed.data.id };
}

/**
 * Lightweight patch — just the email field. Used by the estimate send flow
 * when a customer is missing an email and the operator fills it in inline.
 */
export async function patchCustomerEmailAction(
  customerId: string,
  email: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = email.trim();
  if (!trimmed?.includes('@')) {
    return { ok: false, error: 'Please enter a valid email address.' };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('customers')
    .update({ email: trimmed, updated_at: new Date().toISOString() })
    .eq('id', customerId)
    .is('deleted_at', null);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/contacts/${customerId}`);
  return { ok: true };
}

/**
 * Soft-delete. `customers.deleted_at` exists (migration 0018), so we set it
 * and leave the row in place to preserve foreign-key references from quotes,
 * jobs, and invoices.
 *
 * On success, redirect back to the list. Server-action redirects throw a
 * `NEXT_REDIRECT` error that the framework handles — callers should not
 * try to await a return value.
 */
export async function deleteCustomerAction(id: string): Promise<CustomerActionResult | never> {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'Missing customer id.' };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('customers')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/contacts');
  redirect('/contacts');
}
