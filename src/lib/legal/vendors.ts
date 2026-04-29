/**
 * Read the vendor inventory at build time and expose typed access.
 * Server-only — yaml.parse runs at module load, but the data is
 * static so this is fine to import from server components.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export type VendorEntry = {
  slug: string;
  name: string;
  purpose: string;
  url: string;
  region: string;
  data_types: string[];
  subprocessor_url: string;
  detection: {
    packages: string[];
    env: string[];
  };
  notes?: string;
};

let cache: VendorEntry[] | null = null;

export function loadVendors(): VendorEntry[] {
  if (cache) return cache;
  const path = join(process.cwd(), 'docs', 'legal', 'vendors.yaml');
  const raw = readFileSync(path, 'utf-8');
  const parsed = parse(raw) as { vendors: VendorEntry[] };
  if (!parsed?.vendors || !Array.isArray(parsed.vendors)) {
    throw new Error('docs/legal/vendors.yaml: missing top-level "vendors" array');
  }
  cache = parsed.vendors;
  return cache;
}
