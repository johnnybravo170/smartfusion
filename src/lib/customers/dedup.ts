/**
 * Deterministic customer dedup for the onboarding import wizard.
 *
 * AI proposes the rows; this layer figures out whether each row is a
 * NEW customer or matches one that already exists in the tenant. The
 * AI doesn't get to decide that — dedup is too consequential to be
 * non-deterministic and too cheap to be expensive.
 *
 * Match tiers (highest confidence first):
 *   - `email`  — same normalized email. Near-certain match.
 *   - `phone`  — same normalized phone digits (10+ digits). Strong.
 *   - `name+city` — exact normalized name AND city match. Moderate.
 *   - `name`   — exact normalized name only. Weak; surface for review.
 *
 * Anything weaker than `name` is treated as "no match" — the operator
 * can manually merge later via the customer pages if they spot a dupe.
 *
 * Returns the highest-confidence match for each proposal, plus the
 * tier so the UI can color-code the operator's choice.
 */

export type DedupTier = 'email' | 'phone' | 'name+city' | 'name' | null;

export type ExistingCustomer = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
};

export type ProposedCustomer = {
  name: string;
  email?: string | null;
  phone?: string | null;
  city?: string | null;
};

export type DedupMatch = {
  tier: DedupTier;
  existing: ExistingCustomer | null;
};

/** Lower, trim, collapse whitespace. NULL-safe. */
export function normalizeName(s: string | null | undefined): string {
  if (!s) return '';
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Lower + trim. */
export function normalizeEmail(s: string | null | undefined): string {
  if (!s) return '';
  return s.trim().toLowerCase();
}

/** Digits-only. Drops country code prefix differences ("+1" vs "1" vs ""). */
export function normalizePhone(s: string | null | undefined): string {
  if (!s) return '';
  const digits = s.replace(/\D+/g, '');
  // Strip leading 1 (NANP country code) so "+1 604 555 1234" matches "604-555-1234".
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

/**
 * Find the strongest match in `existing` for `proposed`. Returns
 * `{ tier: null, existing: null }` if no candidate clears the bar.
 *
 * O(n) per call; the caller is expected to fetch the tenant's full
 * customer roster once and pass it in for each proposal.
 */
export function findMatch(proposed: ProposedCustomer, existing: ExistingCustomer[]): DedupMatch {
  const pEmail = normalizeEmail(proposed.email);
  const pPhone = normalizePhone(proposed.phone);
  const pName = normalizeName(proposed.name);
  const pCity = normalizeName(proposed.city);

  if (!pName) return { tier: null, existing: null };

  // Tier 1: email match.
  if (pEmail) {
    const hit = existing.find((c) => normalizeEmail(c.email) === pEmail);
    if (hit) return { tier: 'email', existing: hit };
  }

  // Tier 2: phone match (require at least 10 digits to avoid spurious
  // hits on partial extensions or test data).
  if (pPhone.length >= 10) {
    const hit = existing.find((c) => normalizePhone(c.phone) === pPhone);
    if (hit) return { tier: 'phone', existing: hit };
  }

  // Tier 3: name + city.
  if (pCity) {
    const hit = existing.find(
      (c) => normalizeName(c.name) === pName && normalizeName(c.city) === pCity,
    );
    if (hit) return { tier: 'name+city', existing: hit };
  }

  // Tier 4: name only.
  const nameHit = existing.find((c) => normalizeName(c.name) === pName);
  if (nameHit) return { tier: 'name', existing: nameHit };

  return { tier: null, existing: null };
}

/** Confidence label for the UI. */
export function tierLabel(tier: DedupTier): string {
  switch (tier) {
    case 'email':
      return 'Email match';
    case 'phone':
      return 'Phone match';
    case 'name+city':
      return 'Name + city match';
    case 'name':
      return 'Name only — please confirm';
    default:
      return '';
  }
}
