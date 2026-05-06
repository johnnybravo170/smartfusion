/**
 * Deterministic invoice dedup for the onboarding import wizard.
 *
 * Invoices have weaker stable identifiers than customers (no email/
 * phone) and weaker than projects (no human-readable name). The only
 * realistic match space is:
 *
 *   - **customer + amount + date** — same customer, same total cents
 *     (with small tolerance for rounding), within 3 days of the invoice
 *     date. High-confidence: a contractor doesn't bill the same
 *     customer the same exact amount twice in a 6-day window by
 *     accident.
 *
 * Anything looser (customer-only, amount-only) is intentionally not
 * matched — the cost of a false-positive merge here is a missing
 * historical invoice; the cost of a false-negative is a duplicate the
 * operator can roll back if they catch it. Better to err on the
 * "create + roll back if wrong" side.
 *
 * Strict cents match by default. If a source has rounding drift between
 * its total column and amount+tax cells, the operator can flip the
 * decision per row in the wizard preview.
 */

export type InvoiceMatchTier = 'customer+amount+date' | null;

export type ExistingInvoice = {
  id: string;
  customer_id: string | null;
  amount_cents: number;
  tax_cents: number;
  /** invoice_date — use the earliest of (sent_at, paid_at, created_at)
   *  as the historical anchor. Caller computes this server-side from
   *  the row. */
  anchor_date: string; // ISO date or timestamp
};

export type ProposedInvoice = {
  customerId: string | null;
  totalCents: number; // amount_cents + tax_cents
  invoiceDateIso: string | null; // YYYY-MM-DD or full ISO
};

export type InvoiceDedupMatch = {
  tier: InvoiceMatchTier;
  existing: ExistingInvoice | null;
};

const DAY_MS = 86_400_000;
const MATCH_WINDOW_DAYS = 3;

export function findInvoiceMatch(
  proposed: ProposedInvoice,
  existing: ExistingInvoice[],
): InvoiceDedupMatch {
  if (!proposed.customerId || !proposed.invoiceDateIso) return { tier: null, existing: null };

  const proposedDate = new Date(proposed.invoiceDateIso);
  if (Number.isNaN(proposedDate.getTime())) return { tier: null, existing: null };
  const proposedMs = proposedDate.getTime();

  for (const e of existing) {
    if (e.customer_id !== proposed.customerId) continue;
    if (e.amount_cents + e.tax_cents !== proposed.totalCents) continue;
    const anchorMs = new Date(e.anchor_date).getTime();
    if (Number.isNaN(anchorMs)) continue;
    if (Math.abs(anchorMs - proposedMs) <= MATCH_WINDOW_DAYS * DAY_MS) {
      return { tier: 'customer+amount+date', existing: e };
    }
  }
  return { tier: null, existing: null };
}

export function invoiceTierLabel(tier: InvoiceMatchTier): string {
  switch (tier) {
    case 'customer+amount+date':
      return 'Same customer + amount + date';
    default:
      return '';
  }
}

/** Best-effort dollar-text → cents parser for the LLM-extracted amounts.
 *  Examples handled: "$1,234.56", "1234.56", "1234", "1,234", "$45k".
 *  Returns null on anything we can't parse confidently — caller decides
 *  whether to skip the row or surface for manual entry. */
export function parseDollarTextToCents(s: string | null | undefined): number | null {
  if (!s) return null;
  const trimmed = s.trim().toLowerCase();
  if (!trimmed) return null;
  // Strip currency symbol + commas + leading + sign
  const cleaned = trimmed.replace(/[$,+]/g, '').replace(/^cad\s*/i, '');
  // "45k" / "1.2k" handling
  const kMatch = cleaned.match(/^(-?\d+(?:\.\d+)?)k$/);
  if (kMatch) {
    const n = Number(kMatch[1]);
    if (Number.isFinite(n)) return Math.round(n * 1000 * 100);
    return null;
  }
  // Plain decimal
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
