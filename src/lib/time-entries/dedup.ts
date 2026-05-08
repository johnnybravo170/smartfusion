/**
 * Worker (tenant_member) name resolution for the time-entry import
 * wizard.
 *
 * Time entries differ from the other phases in that the row's
 * "worker" field MUST resolve to a real auth user — we can't auto-
 * create one as a side-effect (auth requires email confirmation,
 * password setup, etc). When a name doesn't match, the wizard either
 * defaults the row to the importer (if first/last match no member at
 * all, the contractor's most likely importing their own historical
 * hours) or skips the row.
 *
 * Match rules:
 *   - exact case-insensitive first + last match
 *   - then exact case-insensitive first-only (rare last-name mismatch
 *     in handwritten payroll sheets)
 *
 * Anything fuzzier is left to manual mapping in the wizard preview.
 */

import { normalizeName } from '@/lib/customers/dedup';

export type ExistingMember = {
  user_id: string;
  first_name: string | null;
  last_name: string | null;
};

export type WorkerMatchTier = 'first+last' | 'first_only' | null;

export type WorkerResolution = {
  tier: WorkerMatchTier;
  userId: string | null;
  /** Pretty label for the UI ("Sam Patel") so the wizard can render
   *  the resolved member without round-tripping. */
  label: string | null;
};

export function findWorkerMatch(
  workerName: string | null | undefined,
  members: ExistingMember[],
): WorkerResolution {
  if (!workerName) return { tier: null, userId: null, label: null };
  const trimmed = workerName.trim();
  if (!trimmed) return { tier: null, userId: null, label: null };

  // Tokenize on whitespace; first chunk = first name candidate, rest
  // joined = last name candidate.
  const tokens = trimmed.split(/\s+/);
  const candidateFirst = normalizeName(tokens[0]);
  const candidateLast = tokens.length > 1 ? normalizeName(tokens.slice(1).join(' ')) : '';

  // Tier 1: first + last
  if (candidateFirst && candidateLast) {
    const hit = members.find(
      (m) =>
        normalizeName(m.first_name) === candidateFirst &&
        normalizeName(m.last_name) === candidateLast,
    );
    if (hit) {
      return {
        tier: 'first+last',
        userId: hit.user_id,
        label: prettyName(hit),
      };
    }
  }

  // Tier 2: first only (sheet might just say "Sam")
  if (candidateFirst) {
    const matches = members.filter((m) => normalizeName(m.first_name) === candidateFirst);
    if (matches.length === 1) {
      return {
        tier: 'first_only',
        userId: matches[0].user_id,
        label: prettyName(matches[0]),
      };
    }
    // Multiple Sams? No deterministic match — let the operator pick.
  }

  return { tier: null, userId: null, label: null };
}

function prettyName(m: ExistingMember): string {
  return [m.first_name, m.last_name].filter(Boolean).join(' ') || '(unnamed member)';
}

export function workerTierLabel(tier: WorkerMatchTier): string {
  switch (tier) {
    case 'first+last':
      return 'First + last name match';
    case 'first_only':
      return 'First name only — confirm';
    default:
      return '';
  }
}
