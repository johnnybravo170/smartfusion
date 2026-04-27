/**
 * CASL guardrail — fails CI if any callsite uses
 * `caslCategory: 'unclassified'` outside the temporary backfill window.
 *
 * 'unclassified' was the placeholder category used while CASL Phase A
 * was being threaded through every send wrapper. Phase B forbids it in
 * new code: every send must declare a real category so the audit trail
 * is meaningful.
 *
 * If you genuinely need a placeholder for an in-flight refactor, add an
 * explicit allow-list entry below with a comment explaining why and a
 * follow-up issue to remove it.
 */

import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * File paths (relative to repo root) that are allowed to mention
 * `'unclassified'` for legitimate reasons (constants, tests, docs).
 */
const ALLOWED_FILES = new Set<string>([
  // The CASL category enum + helpers that define 'unclassified' as a value.
  'src/lib/db/schema/casl.ts',
  // CASL.md and PATTERNS.md may mention it in prose.
  'CASL.md',
  'PATTERNS.md',
  // This guardrail itself.
  'tests/unit/casl-no-unclassified.test.ts',
]);

describe('CASL guardrail: no unclassified sends in source', () => {
  it("no source file uses caslCategory: 'unclassified' outside the allow-list", () => {
    let output = '';
    try {
      output = execSync(
        // -F = literal string (no regex), -r = recursive,
        // skip node_modules, .next, .git, dist, etc.
        "grep -rFn \"caslCategory: 'unclassified'\" src tests --include='*.ts' --include='*.tsx' || true",
        {
          encoding: 'utf-8',
          cwd: process.cwd(),
        },
      );
    } catch {
      // grep returning 1 means no matches — that's the desired outcome.
      output = '';
    }

    const offending = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .filter((line) => {
        const path = line.split(':')[0];
        return !ALLOWED_FILES.has(path);
      });

    expect(
      offending,
      `Found ${offending.length} disallowed caslCategory: 'unclassified' usages:\n${offending.join('\n')}\n\nClassify the send with a real CASL category (transactional / response_to_request / implied_consent_inquiry / implied_consent_ebr / express_consent). See CASL.md.`,
    ).toEqual([]);
  });
});
