/**
 * Timezone guardrail — fails CI if any callsite formats a Date in the
 * runtime timezone without an explicit `timeZone:` argument.
 *
 * Two pattern families are checked:
 *   1. `Date.prototype.toLocaleDateString(...)` / `.toLocaleTimeString(...)`
 *   2. `new Intl.DateTimeFormat(...)`
 *
 * Both, called bare, format in the runtime's tz — UTC on Vercel — which
 * silently produces wrong dates for any user not in UTC. The whole
 * codebase renders timestamps for a contractor whose tenant has a specific
 * timezone; every Date display has to honor that tz.
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
 * Files allowed to format Dates in the runtime tz. Each entry must have
 * a comment explaining why.
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
  'src/app/(dashboard)/calendar/page.tsx',

  // Schedule-Gantt surfaces (operator + customer-facing portal) and the
  // project start-date editor consume YYYY-MM-DD strings directly,
  // construct UTC-midnight Dates from them, and format bare. The display
  // contract is "show the literal date in the YYYY-MM-DD column"; both
  // construction and formatting use the same tz so they're symmetric
  // when the runtime is UTC (Vercel). TODO: revisit if/when these render
  // client-side from a non-UTC browser — the current pattern can shift
  // by a day in that case. Tracked separately, not part of the tz audit.
  'src/components/features/portal/portal-schedule-gantt.tsx',
  'src/components/features/projects/schedule-gantt.tsx',
  'src/components/features/projects/project-start-date-editor.tsx',

  // Worker unavailability form constructs date keys via parseIso ↔ isoDate
  // round-trip identical to the calendar pattern above; submitted to the
  // server as opaque YYYY-MM-DD strings.
  'src/components/features/worker/unavailability-form.tsx',

  // Platform-admin surface (no per-tenant tz). Hardcodes 'America/Vancouver'
  // explicitly — already correct usage.
  'src/app/(admin)/admin/ar/sequences/[id]/page.tsx',

  // This guardrail itself.
  'tests/unit/timezone-no-bare-tolocale.test.ts',
]);

/**
 * Reads file contents lazily, caching results. Used to peek at the lines
 * after a grep match (so wrapped-arg `timeZone:` declarations on a later
 * line still count as tz-aware).
 */
function makeReader() {
  const fileCache = new Map<string, string[]>();
  return (filePath: string): string[] => {
    const cached = fileCache.get(filePath);
    if (cached) return cached;
    const out = readFileSync(filePath, 'utf-8').split('\n');
    fileCache.set(filePath, out);
    return out;
  };
}

/**
 * Scan src/ for a regex pattern, returning grep-style offending lines.
 * Filters out:
 *   - Allowlisted files
 *   - Lines that include `timeZone:` directly
 *   - Lines whose next 5 lines include `timeZone:` (wrapped-arg case)
 */
function scanForOffenders(pattern: string): string[] {
  let output = '';
  try {
    output = execSync(`grep -rEn '${pattern}' src --include='*.ts' --include='*.tsx' || true`, {
      encoding: 'utf-8',
      cwd: process.cwd(),
    });
  } catch {
    output = '';
  }

  const rawLines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const readLines = makeReader();
  const offending: string[] = [];

  for (const line of rawLines) {
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, lineStrRaw, code] = m;
    const lineNum = Number(lineStrRaw);

    if (ALLOWED_FILES.has(file)) continue;
    if (code.includes('timeZone:')) continue;

    // Look at the next 10 lines for a wrapped-arg `timeZone:`. Wide
    // enough to cover wide options-objects with several keys before tz.
    const allLines = readLines(file);
    const peek = allLines.slice(lineNum, lineNum + 10).join('\n');
    if (peek.includes('timeZone:')) continue;

    offending.push(line);
  }

  return offending;
}

describe('Timezone guardrail', () => {
  it('no source file uses bare toLocaleDateString / toLocaleTimeString without timeZone', () => {
    const offending = scanForOffenders('toLocale(Date|Time)String\\(');

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

  it('no source file constructs Intl.DateTimeFormat without a timeZone arg', () => {
    const offending = scanForOffenders('new Intl\\.DateTimeFormat\\(');

    if (offending.length > 0) {
      const msg = [
        'Bare `new Intl.DateTimeFormat(...)` without a `timeZone:` option:',
        '',
        ...offending.map((l) => `  ${l}`),
        '',
        'Same UTC-on-Vercel bug as bare toLocale*. Always pass',
        '{ timeZone: <tenant.timezone> } or useTenantTimezone() in client',
        'code. If you genuinely need a runtime-tz round-trip (e.g. day math',
        'paired with parseIso), add the file to the allowlist with a',
        'comment explaining why.',
      ].join('\n');
      expect.fail(msg);
    }
  });
});
