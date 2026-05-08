/**
 * Timezone guardrail — fails CI if any callsite uses bare `toLocaleDateString`
 * or `toLocaleTimeString` on a Date without an explicit `timeZone:` argument.
 *
 * The whole codebase renders timestamps for a contractor whose tenant has a
 * specific timezone. Bare `Date.prototype.toLocaleDateString(...)` formats in
 * the runtime's tz — UTC on Vercel — which silently produces wrong dates for
 * any user not in UTC.
 *
 * Use one of:
 *   - `formatDate(d, { timezone })` from `src/lib/date/format.ts`
 *   - `new Intl.DateTimeFormat('en-CA', { timeZone, ... }).format(d)`
 *
 * For client components, `useTenantTimezone()` from
 * `src/lib/auth/tenant-context.tsx` provides the tenant tz.
 *
 * If you need bare runtime-tz formatting (e.g. for an internally consistent
 * date-string round-trip where every Date is constructed and formatted in
 * the same runtime tz), add an entry to the allowlist below with a comment
 * explaining why.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Files allowed to use bare `toLocaleDateString` / `toLocaleTimeString`.
 * Each entry must have a comment explaining why.
 */
const ALLOWED_FILES = new Set<string>([
  // The format.ts helpers themselves use Intl.DateTimeFormat directly with
  // a timeZone arg; they are the canonical implementation.
  'src/lib/date/format.ts',

  // Owner calendar uses parseIso (constructs runtime-tz Date) + isoDate
  // (formats in runtime tz) symmetrically. Tenant-local "today" is checked
  // separately via isToday(iso, tz). The display calls use bare Intl on
  // parseIso-derived dates intentionally — runtime-tz consistent.
  'src/components/features/calendar/owner-calendar.tsx',
  'src/components/features/calendar/assign-workers-dialog.tsx',

  // Platform-admin surface (no per-tenant tz). Hardcodes 'America/Vancouver'
  // explicitly — already correct usage.
  'src/app/(admin)/admin/ar/sequences/[id]/page.tsx',

  // Home Record PDF + ZIP generators. The frozen snapshot doesn't carry tz;
  // these helpers run server-side and would need tz threaded through every
  // formatDate call. Larger refactor — tracked as follow-up.
  'src/lib/pdf/home-record-pdf.ts',
  'src/lib/zip/home-record-zip.ts',

  // Social-post API route — single use, low-impact (weekday label for AI
  // post generation). Tracked as follow-up.
  'src/app/api/social-post/route.ts',

  // This guardrail itself.
  'tests/unit/timezone-no-bare-tolocale.test.ts',
]);

describe('Timezone guardrail: no bare toLocale on Dates', () => {
  it('no source file uses bare toLocaleDateString / toLocaleTimeString without timeZone', () => {
    let output = '';
    try {
      output = execSync(
        // -E = ERE; -n = line numbers; -r = recursive.
        // Match either method name directly. We then post-filter to drop
        // lines that include `timeZone:` (already explicit) or the line
        // immediately after that includes `timeZone:` on a wrapped call.
        "grep -rEn 'toLocale(Date|Time)String\\(' src --include='*.ts' --include='*.tsx' || true",
        {
          encoding: 'utf-8',
          cwd: process.cwd(),
        },
      );
    } catch {
      output = '';
    }

    // Walk the grep output and find the next 5 lines after each match in the
    // file so we can detect `timeZone:` appearing on a wrapped-arg line.
    const rawLines = output
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const offending: string[] = [];

    // We need to read each match's source file to peek at the next ~5 lines
    // for a wrapped-arg `timeZone:` declaration. Using a small in-memory
    // cache to avoid re-reading the same file repeatedly.
    const fileCache = new Map<string, string[]>();
    const readLines = (filePath: string): string[] => {
      const cached = fileCache.get(filePath);
      if (cached) return cached;
      const out = readFileSync(filePath, 'utf-8').split('\n');
      fileCache.set(filePath, out);
      return out;
    };

    for (const line of rawLines) {
      // Format: "src/path/file.tsx:123:    code with toLocaleDateString(..."
      const m = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!m) continue;
      const [, file, lineStrRaw, code] = m;
      const lineNum = Number(lineStrRaw);

      if (ALLOWED_FILES.has(file)) continue;

      // If the line itself includes `timeZone:`, it's already tz-aware.
      if (code.includes('timeZone:')) continue;

      // Otherwise peek up to 5 following lines for a wrapped `timeZone:` arg.
      const allLines = readLines(file);
      const peek = allLines.slice(lineNum, lineNum + 5).join('\n');
      if (peek.includes('timeZone:')) continue;

      offending.push(line);
    }

    if (offending.length > 0) {
      const msg = [
        'Bare toLocaleDateString / toLocaleTimeString without timeZone arg:',
        '',
        ...offending.map((l) => `  ${l}`),
        '',
        'Use formatDate from src/lib/date/format.ts, or pass { timeZone }',
        'explicitly to Intl.DateTimeFormat. For client components,',
        'useTenantTimezone() returns the tenant tz.',
      ].join('\n');
      expect.fail(msg);
    }
  });
});
