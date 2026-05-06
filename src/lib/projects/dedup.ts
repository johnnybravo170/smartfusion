/**
 * Deterministic project dedup for the onboarding import wizard.
 *
 * Projects don't have a stable identifier the way customers have email/
 * phone, so the match space is intentionally narrow:
 *
 *   - `customer_and_name` — same customer (FK already resolved or
 *     matched by name) AND same normalized project name. High-
 *     confidence: "the Smith Bathroom" only ever exists once per
 *     customer.
 *   - `name_only` — same normalized project name across the whole
 *     tenant. Weaker; surface as "review this match" rather than
 *     auto-merge.
 *
 * Anything looser (substring match, fuzzy distance, etc.) is left to a
 * future revision — the cost of a false-positive merge here is high
 * (two real projects collapse into one) and the cost of a false-
 * negative is low (operator gets a near-duplicate they can rename or
 * merge later via the project pages).
 */

import { normalizeName } from '@/lib/customers/dedup';

export type ProjectMatchTier = 'customer+name' | 'name' | null;

export type ExistingProject = {
  id: string;
  name: string;
  customer_id: string | null;
  customer_name: string | null;
};

export type ProposedProject = {
  name: string;
  customerName?: string | null;
  /** Resolved customer id, if the operator has already confirmed a match. */
  customerId?: string | null;
};

export type ProjectDedupMatch = {
  tier: ProjectMatchTier;
  existing: ExistingProject | null;
};

export function findProjectMatch(
  proposed: ProposedProject,
  existing: ExistingProject[],
): ProjectDedupMatch {
  const pName = normalizeName(proposed.name);
  if (!pName) return { tier: null, existing: null };

  // Tier 1: same customer + same project name.
  // We accept either a resolved customer_id OR a customer_name match
  // against the existing project's customer_name.
  const pCustomerName = normalizeName(proposed.customerName);
  const pCustomerId = proposed.customerId ?? null;
  if (pCustomerId || pCustomerName) {
    const hit = existing.find((p) => {
      if (normalizeName(p.name) !== pName) return false;
      if (pCustomerId && p.customer_id === pCustomerId) return true;
      if (pCustomerName && normalizeName(p.customer_name) === pCustomerName) return true;
      return false;
    });
    if (hit) return { tier: 'customer+name', existing: hit };
  }

  // Tier 2: same project name across the tenant. Surface for review;
  // the wizard UI will default the decision to 'create' on this tier
  // since project names commonly repeat ("Bathroom Reno" can legitimately
  // exist for many customers).
  const nameHit = existing.find((p) => normalizeName(p.name) === pName);
  if (nameHit) return { tier: 'name', existing: nameHit };

  return { tier: null, existing: null };
}

export function projectTierLabel(tier: ProjectMatchTier): string {
  switch (tier) {
    case 'customer+name':
      return 'Same customer + name';
    case 'name':
      return 'Same project name (different customer?)';
    default:
      return '';
  }
}
