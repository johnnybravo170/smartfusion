import { describe, expect, it } from 'vitest';
import { FEATURE_CATALOG, findFeatureByPath, searchFeatures } from '@/lib/ai/feature-catalog';

describe('feature catalog', () => {
  it('has unique paths', () => {
    const paths = FEATURE_CATALOG.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('every entry has a non-empty name and summary', () => {
    for (const f of FEATURE_CATALOG) {
      expect(f.name.trim().length).toBeGreaterThan(0);
      expect(f.summary.trim().length).toBeGreaterThan(0);
    }
  });

  describe('findFeatureByPath', () => {
    it('matches an exact path', () => {
      expect(findFeatureByPath('/referrals')?.name).toBe('Refer & Earn');
    });

    it('strips querystring and trailing slash', () => {
      expect(findFeatureByPath('/referrals/?utm=x')?.path).toBe('/referrals');
      expect(findFeatureByPath('/referrals#hash')?.path).toBe('/referrals');
    });

    it('falls back to the longest matching prefix for sub-routes', () => {
      // /projects/<id> isn't catalogued; should resolve to /projects.
      expect(findFeatureByPath('/projects/abc-123')?.path).toBe('/projects');
    });

    it('returns null for unknown routes', () => {
      expect(findFeatureByPath('/totally-fake-page')).toBeNull();
    });

    it('handles null / empty input', () => {
      expect(findFeatureByPath(null)).toBeNull();
      expect(findFeatureByPath('')).toBeNull();
    });
  });

  describe('searchFeatures', () => {
    it('finds the referrals page from natural-language queries', () => {
      const hits = searchFeatures('how do I refer a friend');
      expect(hits[0]?.path).toBe('/referrals');
    });

    it('finds invoicing from "send a bill"', () => {
      const hits = searchFeatures('send a bill');
      expect(hits.some((f) => f.path === '/invoices')).toBe(true);
    });

    it('returns empty array for empty input', () => {
      expect(searchFeatures('')).toEqual([]);
    });

    it('respects limit', () => {
      const hits = searchFeatures('settings', 2);
      expect(hits.length).toBeLessThanOrEqual(2);
    });
  });
});
