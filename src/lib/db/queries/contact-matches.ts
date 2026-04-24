/**
 * Fuzzy-match helpers used by the dedup banner on every contact-create
 * surface. Returns two tiers:
 *
 *   - strong: phone (digits-only last-7 match), email (exact), or an
 *     exact name match. These are treated as "same person" by the banner —
 *     the operator must either pick an existing record or explicitly opt
 *     into creating a new one ("Create anyway").
 *   - weak: a trigram name similarity above the threshold but not exact.
 *     Two different people can genuinely share a name ("John Doe" vs
 *     "John Doe"), so the banner for weak-only matches reads as an FYI
 *     and "Create new" is a first-class button, not a scary escape.
 */

import { createClient } from '@/lib/supabase/server';
import type { ContactMatch } from './contact-matches-types';

export type { ContactMatch, ContactMatchStrength } from './contact-matches-types';

/** Minimum trigram similarity before we'll flag a name as a weak match. */
const FUZZY_NAME_THRESHOLD = 0.4;

/** Phone → digits only, trimmed. Handles +1/604-/spaces. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return null;
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

export async function findContactMatches(input: {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  excludeId?: string;
}): Promise<ContactMatch[]> {
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);
  const name = normalizeName(input.name);
  const rawName = input.name?.trim() ?? null;

  if (!phone && !email && !name) return [];

  const supabase = await createClient();
  const results = new Map<string, ContactMatch>();

  // Strong: phone match.
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
        results.set(row.id, {
          ...(row as Omit<ContactMatch, 'matchedOn' | 'strength'>),
          matchedOn: 'phone',
          strength: 'strong',
        });
      }
    }
  }

  // Strong: email match.
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
        results.set(row.id, {
          ...(row as Omit<ContactMatch, 'matchedOn' | 'strength'>),
          matchedOn: 'email',
          strength: 'strong',
        });
      }
    }
  }

  // Strong: exact name match (case-insensitive).
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
        results.set(row.id, {
          ...(row as Omit<ContactMatch, 'matchedOn' | 'strength'>),
          matchedOn: 'name',
          strength: 'strong',
        });
      }
    }
  }

  // Weak: trigram similar name (not already captured above).
  if (rawName && rawName.length >= 2) {
    const { data } = await supabase.rpc('find_similar_contacts', {
      p_name: rawName,
      p_threshold: FUZZY_NAME_THRESHOLD,
      p_limit: 5,
      p_exclude_id: input.excludeId ?? null,
    });
    for (const row of (data ?? []) as Array<{
      id: string;
      name: string;
      kind: ContactMatch['kind'];
      email: string | null;
      phone: string | null;
      similarity: number;
    }>) {
      if (results.has(row.id)) continue;
      // Skip exact-ish trigram matches — those would already have shown up
      // as a strong `name` match above. 0.99+ is effectively equal.
      if (row.similarity >= 0.99) continue;
      results.set(row.id, {
        id: row.id,
        name: row.name,
        kind: row.kind,
        email: row.email,
        phone: row.phone,
        matchedOn: 'similar_name',
        strength: 'weak',
        similarity: row.similarity,
      });
    }
  }

  return [...results.values()];
}

/** Convenience — true when any match in the list is a strong signal. */
export function hasStrongMatch(matches: ContactMatch[]): boolean {
  return matches.some((m) => m.strength === 'strong');
}
