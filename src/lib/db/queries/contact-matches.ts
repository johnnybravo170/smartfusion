/**
 * Fuzzy-match helpers used by the intake review screen to flag possible
 * duplicate contacts before we create a new one. Normalization is
 * intentionally loose (digits-only for phone, lowercased-trimmed for
 * name/email) so minor formatting differences don't hide a real match.
 *
 * Matches are scored by which field agreed (phone > email > name) and the
 * caller decides how to present them.
 */

import { createClient } from '@/lib/supabase/server';

export type ContactMatch = {
  id: string;
  name: string;
  kind: 'customer' | 'vendor' | 'sub' | 'agent' | 'inspector' | 'referral' | 'other';
  email: string | null;
  phone: string | null;
  matchedOn: 'phone' | 'email' | 'name';
};

/** Phone → digits only, trimmed. Handles +1/604-/spaces. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return null;
  // Strip a leading '1' for North American numbers so '1-604-555-0100' and
  // '604-555-0100' match.
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.includes('@') ? trimmed : null;
}

export function normalizeName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return trimmed.length >= 2 ? trimmed : null;
}

/**
 * Find existing contacts that might be the same person as the one the
 * operator is about to create. Matches on phone (strongest), email, or
 * name equality. `excludeId` lets an augment flow skip the contact being
 * edited.
 */
export async function findContactMatches(input: {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  excludeId?: string;
}): Promise<ContactMatch[]> {
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);
  const name = normalizeName(input.name);

  if (!phone && !email && !name) return [];

  const supabase = await createClient();
  const results = new Map<string, ContactMatch>();

  // Phone match — strongest signal. Use ilike on the last 7 digits so the
  // match survives country-code prefix differences.
  if (phone) {
    const last7 = phone.slice(-7);
    const { data } = await supabase
      .from('customers')
      .select('id, name, kind, email, phone')
      .ilike('phone', `%${last7}%`)
      .is('deleted_at', null)
      .limit(5);
    for (const row of data ?? []) {
      if (input.excludeId && row.id === input.excludeId) continue;
      const rowPhone = normalizePhone(row.phone);
      if (rowPhone && (rowPhone === phone || rowPhone.endsWith(last7))) {
        results.set(row.id, { ...(row as ContactMatch), matchedOn: 'phone' });
      }
    }
  }

  if (email) {
    const { data } = await supabase
      .from('customers')
      .select('id, name, kind, email, phone')
      .eq('email', email)
      .is('deleted_at', null)
      .limit(5);
    for (const row of data ?? []) {
      if (input.excludeId && row.id === input.excludeId) continue;
      if (!results.has(row.id)) {
        results.set(row.id, { ...(row as ContactMatch), matchedOn: 'email' });
      }
    }
  }

  if (name) {
    const { data } = await supabase
      .from('customers')
      .select('id, name, kind, email, phone')
      .ilike('name', name)
      .is('deleted_at', null)
      .limit(5);
    for (const row of data ?? []) {
      if (input.excludeId && row.id === input.excludeId) continue;
      if (!results.has(row.id)) {
        results.set(row.id, { ...(row as ContactMatch), matchedOn: 'name' });
      }
    }
  }

  return [...results.values()];
}
