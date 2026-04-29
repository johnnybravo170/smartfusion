#!/usr/bin/env tsx
/**
 * Vendor coverage lint.
 *
 * Walks package.json deps and every `process.env.*` reference in the
 * codebase. For each one, asks "does this look like a third-party
 * vendor signature, and if so is it covered by docs/legal/vendors.yaml?"
 *
 * The privacy page renders directly from vendors.yaml, so missing
 * entries = the public privacy policy lying. Fail the PR loudly.
 *
 * Heuristic: a "vendor signature" is one that matches a
 * `detection.packages[]` or `detection.env[]` regex of an existing
 * vendor entry. New stuff that matches nothing is reported as
 * "needs review" — false positives are easier to ignore than silent
 * gaps.
 *
 * Exit codes:
 *   0 = clean
 *   1 = at least one vendor signature found that doesn't match any
 *       existing entry, OR an entry's detection patterns matched
 *       nothing (probably stale entry).
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

type VendorEntry = {
  slug: string;
  name: string;
  detection: { packages: string[]; env: string[] };
};

const ROOT = process.cwd();

// Known vendor-ish env var prefixes we definitely want covered. Keep
// in sync with broad patterns in vendors.yaml — anything matching
// here that isn't covered is a guaranteed gap.
const VENDOR_SIGNAL_ENV_PREFIXES = [
  'AWS_',
  'ANTHROPIC_',
  'GEMINI_',
  'GOOGLE_AI_',
  'GOOGLE_API_',
  'NEXT_PUBLIC_GOOGLE_MAPS_',
  'NEXT_PUBLIC_SENTRY_',
  'NEXT_PUBLIC_SUPABASE_',
  'OPENAI_',
  'POSTHOG_',
  'R2_',
  'RESEND_',
  'SENTRY_',
  'STRIPE_',
  'SUPABASE_',
  'TWILIO_',
  'VERCEL_',
];

// Internal env vars that are NOT vendor signatures (e.g. our own
// service URLs). Match exact name; a longer suppression list here
// is fine, the cost of forgetting is just a noisy false positive.
const INTERNAL_ENV_NAMES = new Set([
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_OPS_BASE_URL',
  'AR_PUBLIC_BASE_URL',
  'OPS_BASE_URL',
  'OPS_FEEDBACK_KEY',
  'OPS_ALERTS_FROM_EMAIL',
  'OPS_ALERTS_TO_EMAIL',
  'PHOTO_CLASSIFIER_MODEL',
  'PULSE_MODEL',
]);

function loadVendors(): VendorEntry[] {
  const raw = readFileSync(join(ROOT, 'docs', 'legal', 'vendors.yaml'), 'utf-8');
  const parsed = parseYaml(raw) as { vendors: VendorEntry[] };
  return parsed.vendors;
}

function readPackageDeps(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
}

function readEnvReferences(): string[] {
  // Scan src/ for runtime references AND .github/workflows for CI
  // references — backup / restore secrets only show up in workflow
  // YAML, not in the app code.
  const found = new Set<string>();
  for (const path of ['src/', '.github/workflows/']) {
    try {
      const out = execSync(
        `grep -rohE '(process\\.env\\.[A-Z][A-Z0-9_]+|secrets\\.[A-Z][A-Z0-9_]+)' ${path} 2>/dev/null | sort -u`,
        { encoding: 'utf-8', cwd: ROOT },
      );
      for (const raw of out.split('\n')) {
        const trimmed = raw
          .trim()
          .replace(/^process\.env\./, '')
          .replace(/^secrets\./, '');
        if (trimmed) found.add(trimmed);
      }
    } catch {
      // grep returns 1 when there are no matches; ignore.
    }
  }
  return Array.from(found);
}

function matches(value: string, patterns: string[]): boolean {
  return patterns.some((p) => new RegExp(p).test(value));
}

function main(): void {
  const vendors = loadVendors();
  const deps = readPackageDeps();
  const envs = readEnvReferences();

  const issues: string[] = [];

  // For each dep, if it looks vendor-y (scoped or has a known prefix),
  // confirm at least one vendor entry matches.
  const knownDepPatterns = vendors.flatMap((v) => v.detection.packages ?? []);
  for (const dep of deps) {
    // Skip our own scope.
    if (dep.startsWith('@heyhenry/') || dep.startsWith('@henryos/')) continue;
    // Only flag scoped packages and a small set of bare names — bare
    // packages are almost never vendor signatures.
    const looksVendory =
      dep.startsWith('@') || ['stripe', 'twilio', 'resend', 'openai'].includes(dep);
    // 'supabase' bare is the CLI dev tool (used for migrations), not a
    // runtime data flow — covered by @supabase/* on the runtime side.
    if (!looksVendory) continue;
    if (!matches(dep, knownDepPatterns)) {
      // Not all scoped packages are vendor signatures (e.g.
      // @types/*, @testing-library/*, @next/*). Quick allowlist.
      const innerAllow = [
        '^@types/',
        '^@testing-library/',
        '^@next/',
        '^@playwright/',
        '^@biomejs/',
        '^@tailwindcss/',
        '^@radix-ui/',
        '^@hookform/',
        '^@dnd-kit/', // UI drag/drop, no vendor data flow
        '^@vitest/', // test runner UI
        '^@sentry/', // covered, but multiple subpackages
        '^@react-google-maps/', // covered
      ];
      if (innerAllow.some((p) => new RegExp(p).test(dep))) continue;
      issues.push(
        `dep "${dep}" looks vendor-ish but isn't matched by any vendor in docs/legal/vendors.yaml`,
      );
    }
  }

  // For each env var matching a vendor-signal prefix, confirm coverage.
  const knownEnvPatterns = vendors.flatMap((v) => v.detection.env ?? []);
  for (const env of envs) {
    if (INTERNAL_ENV_NAMES.has(env)) continue;
    const looksVendory = VENDOR_SIGNAL_ENV_PREFIXES.some((p) => env.startsWith(p));
    if (!looksVendory) continue;
    if (!matches(env, knownEnvPatterns)) {
      issues.push(
        `env "${env}" looks vendor-ish but isn't matched by any vendor in docs/legal/vendors.yaml`,
      );
    }
  }

  // Stale entry check: every vendor's detection patterns should match
  // SOMETHING. An entry that matches nothing is dead weight in the
  // privacy policy.
  for (const v of vendors) {
    const pkgPatterns = v.detection.packages ?? [];
    const envPatterns = v.detection.env ?? [];
    if (pkgPatterns.length === 0 && envPatterns.length === 0) continue;
    const hasPkg = pkgPatterns.some((p) => deps.some((d) => new RegExp(p).test(d)));
    const hasEnv = envPatterns.some((p) => envs.some((e) => new RegExp(p).test(e)));
    if (!hasPkg && !hasEnv) {
      issues.push(
        `vendor "${v.slug}" has detection patterns but nothing in the codebase matches — stale entry?`,
      );
    }
  }

  if (issues.length === 0) {
    console.log('✓ vendor coverage clean');
    return;
  }
  console.error('✗ vendor coverage issues:');
  for (const issue of issues) console.error(`  - ${issue}`);
  console.error(
    '\nAdd or update entries in docs/legal/vendors.yaml. The /privacy page renders from this file.',
  );
  process.exit(1);
}

main();
