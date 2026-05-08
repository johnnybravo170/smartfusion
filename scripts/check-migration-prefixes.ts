#!/usr/bin/env tsx
/**
 * Migration prefix collision lint.
 *
 * Scans `supabase/migrations/` and asserts that no two files share the
 * same version prefix. Catches the silent-skip bug where two PRs land
 * with the same NNNN prefix (Supabase tracks one migration per version,
 * the second to deploy is recorded but its SQL never runs — entire
 * features ship live in code with no DB schema behind them).
 *
 * Two prefix formats are recognised:
 *   - 4-digit legacy:     "NNNN_..."     e.g. 0185_import_batches
 *   - 14-digit timestamp: "YYYYMMDDHHMMSS_..." e.g. 20260420164839_remote_commit
 *
 * Both are valid; the convention is moving toward timestamps because
 * they don't collide. See AGENTS.md migration-conventions section.
 *
 * Exit codes:
 *   0 = no collisions
 *   1 = at least one prefix is reused across multiple files
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

const PREFIX_RE = /^(\d{4}|\d{14})_/;

function main(): void {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));

  // Bucket files by prefix.
  const byPrefix = new Map<string, string[]>();
  const unparseable: string[] = [];
  for (const f of files) {
    const m = f.match(PREFIX_RE);
    if (!m) {
      unparseable.push(f);
      continue;
    }
    const prefix = m[1];
    const list = byPrefix.get(prefix) ?? [];
    list.push(f);
    byPrefix.set(prefix, list);
  }

  let failed = false;

  // Collisions.
  const collisions = Array.from(byPrefix.entries()).filter(([, list]) => list.length > 1);
  if (collisions.length > 0) {
    failed = true;
    console.error('✗ migration prefix collisions:');
    for (const [prefix, list] of collisions) {
      console.error(`  - ${prefix} used by ${list.length} files:`);
      for (const f of list) console.error(`      ${f}`);
    }
    console.error('');
    console.error(
      'Two files with the same prefix means whichever runs first is registered in supabase_migrations; the others are silently skipped at deploy time.',
    );
    console.error(
      'Fix: rename one of the colliding files to a fresh prefix. Prefer the timestamp format (YYYYMMDDHHMMSS_*) so this stops happening — see AGENTS.md.',
    );
  }

  // Unrecognised filenames are reported but not fatal — keeps the door
  // open for one-off remote_commit-style names if they ever appear.
  if (unparseable.length > 0) {
    console.warn('? migration files with unrecognised prefixes (not fatal):');
    for (const f of unparseable) console.warn(`    ${f}`);
  }

  if (failed) process.exit(1);
  console.log(
    `✓ migration prefixes clean (${files.length} files, ${byPrefix.size} unique prefixes)`,
  );
}

main();
