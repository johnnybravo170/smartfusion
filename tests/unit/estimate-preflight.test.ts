import { describe, expect, it } from 'vitest';
import {
  type PreflightCategory,
  type PreflightLine,
  runEstimatePreflight,
} from '@/lib/estimate/preflight';

const cat = (id: string, name: string, estimateCents: number): PreflightCategory => ({
  id,
  name,
  estimate_cents: estimateCents,
});

const line = (
  id: string,
  label: string,
  pricePriceCents: number,
  budget_category_id: string | null = null,
): PreflightLine => ({
  id,
  label,
  line_price_cents: pricePriceCents,
  budget_category_id,
});

describe('runEstimatePreflight — zero line items', () => {
  it('flags every line with line_price_cents = 0', () => {
    const result = runEstimatePreflight({
      lines: [line('a', 'Drywall', 0), line('b', 'Paint', 50000), line('c', 'Tile', 0)],
      categories: [],
    });
    expect(result.zeroLines).toHaveLength(2);
    expect(result.zeroLines.map((z) => z.id).sort()).toEqual(['a', 'c']);
  });

  it('attaches the category name when the line has one', () => {
    const result = runEstimatePreflight({
      lines: [line('a', 'Trim', 0, 'cat-1')],
      categories: [cat('cat-1', 'Finishes', 0)],
    });
    expect(result.zeroLines[0].categoryName).toBe('Finishes');
  });

  it('falls back to "Untitled line" when the label is empty', () => {
    const result = runEstimatePreflight({
      lines: [line('a', '', 0)],
      categories: [],
    });
    expect(result.zeroLines[0].label).toBe('Untitled line');
  });

  it('returns no warnings when every line is priced and no envelopes exist', () => {
    const result = runEstimatePreflight({
      lines: [line('a', 'Drywall', 100000), line('b', 'Paint', 50000)],
      categories: [],
    });
    expect(result.totalIssues).toBe(0);
  });
});

describe('runEstimatePreflight — envelope vs lines mismatch', () => {
  it('flags a category where the envelope is set but no lines exist (the Connect Contracting bug)', () => {
    const result = runEstimatePreflight({
      lines: [],
      categories: [cat('cat-1', 'Painting (downstairs)', 500000)],
    });
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({
      categoryId: 'cat-1',
      envelopeCents: 500000,
      linesTotalCents: 0,
      diffCents: 500000,
    });
  });

  it('flags a category where lines exceed the envelope by more than $1', () => {
    const result = runEstimatePreflight({
      lines: [line('a', 'Tile', 600000, 'cat-1')],
      categories: [cat('cat-1', 'Bath', 500000)],
    });
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0].diffCents).toBe(-100000);
  });

  it('does not flag a category where the envelope is 0 (no operator intent)', () => {
    const result = runEstimatePreflight({
      lines: [line('a', 'Drywall', 100000, 'cat-1')],
      categories: [cat('cat-1', 'Demo', 0)],
    });
    expect(result.mismatches).toHaveLength(0);
  });

  it('tolerates rounding drift up to $1', () => {
    const result = runEstimatePreflight({
      lines: [line('a', 'Tile', 99999, 'cat-1')], // $999.99
      categories: [cat('cat-1', 'Bath', 100000)], // $1,000.00
    });
    expect(result.mismatches).toHaveLength(0);
  });

  it('flags drift exceeding the $1 tolerance', () => {
    const result = runEstimatePreflight({
      lines: [line('a', 'Tile', 99800, 'cat-1')], // $998.00
      categories: [cat('cat-1', 'Bath', 100000)], // $1,000.00 — $2 short
    });
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0].diffCents).toBe(200);
  });

  it('does not flag a perfectly-matched envelope + lines', () => {
    const result = runEstimatePreflight({
      lines: [line('a', 'Demo', 50000, 'cat-1'), line('b', 'Disposal', 50000, 'cat-1')],
      categories: [cat('cat-1', 'Demolition', 100000)],
    });
    expect(result.totalIssues).toBe(0);
  });
});

describe('runEstimatePreflight — combined', () => {
  it('returns both warning types simultaneously', () => {
    const result = runEstimatePreflight({
      lines: [
        line('a', 'Trim', 0, 'cat-1'), // zero line
        line('b', 'Paint', 30000, 'cat-1'), // priced
      ],
      categories: [cat('cat-1', 'Finishes', 100000)], // envelope $1000, lines $300 → mismatch
    });
    expect(result.zeroLines).toHaveLength(1);
    expect(result.mismatches).toHaveLength(1);
    expect(result.totalIssues).toBe(2);
  });
});
