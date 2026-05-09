/**
 * Pre-send sanity checks for an estimate / quote.
 *
 * Two warning types, both non-blocking:
 *
 *   1. Zero-price line items — a cost line with `line_price_cents = 0`
 *      that's about to render to the customer as "$0.00" next to a
 *      labelled scope item. Almost always a placeholder the operator
 *      forgot to fill in; AI scope scaffolding and starter templates
 *      both insert these intentionally for the operator to price up.
 *
 *   2. Category vs lines mismatch — the operator set an envelope on a
 *      budget category but the sum of cost lines under it doesn't match
 *      (in either direction, more than a dollar of drift). Catches the
 *      specific bug Connect Contracting hit: $5000 typed at the
 *      category level, lines never priced, customer saw $0.
 *
 * The send-confirm dialog and the preview page both render these.
 * Pure data transform — no DB calls. The page already loads cost lines
 * and categories for rendering; we run preflight on the same shapes.
 */

const MISMATCH_TOLERANCE_CENTS = 100;

export type PreflightLine = {
  id: string;
  label: string | null;
  line_price_cents: number;
  budget_category_id: string | null;
};

export type PreflightCategory = {
  id: string;
  name: string;
  estimate_cents: number;
};

export type ZeroLineWarning = {
  id: string;
  label: string;
  categoryName: string | null;
};

export type MismatchWarning = {
  categoryId: string;
  categoryName: string;
  envelopeCents: number;
  linesTotalCents: number;
  diffCents: number;
};

export type EstimatePreflight = {
  zeroLines: ZeroLineWarning[];
  mismatches: MismatchWarning[];
  totalIssues: number;
};

export function runEstimatePreflight(input: {
  lines: PreflightLine[];
  categories: PreflightCategory[];
}): EstimatePreflight {
  const categoryById = new Map<string, PreflightCategory>();
  for (const c of input.categories) categoryById.set(c.id, c);

  const zeroLines: ZeroLineWarning[] = [];
  const linesByCategory = new Map<string, PreflightLine[]>();

  for (const line of input.lines) {
    if (line.line_price_cents === 0) {
      const cat = line.budget_category_id ? categoryById.get(line.budget_category_id) : undefined;
      zeroLines.push({
        id: line.id,
        label: (line.label ?? '').trim() || 'Untitled line',
        categoryName: cat?.name ?? null,
      });
    }
    if (line.budget_category_id) {
      const list = linesByCategory.get(line.budget_category_id) ?? [];
      list.push(line);
      linesByCategory.set(line.budget_category_id, list);
    }
  }

  const mismatches: MismatchWarning[] = [];
  for (const cat of input.categories) {
    if (cat.estimate_cents <= 0) continue;
    const linesTotal = (linesByCategory.get(cat.id) ?? []).reduce(
      (sum, l) => sum + l.line_price_cents,
      0,
    );
    const diff = cat.estimate_cents - linesTotal;
    if (Math.abs(diff) > MISMATCH_TOLERANCE_CENTS) {
      mismatches.push({
        categoryId: cat.id,
        categoryName: cat.name,
        envelopeCents: cat.estimate_cents,
        linesTotalCents: linesTotal,
        diffCents: diff,
      });
    }
  }

  return {
    zeroLines,
    mismatches,
    totalIssues: zeroLines.length + mismatches.length,
  };
}
