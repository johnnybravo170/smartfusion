#!/usr/bin/env tsx
/**
 * Weekly privacy-policy drift agent (Gemini Flash).
 *
 * Compares three things and flags inconsistencies:
 *   1. docs/legal/vendors.yaml      — what we say in the policy
 *   2. The actual codebase signals  — package.json deps, env refs,
 *      recent commits touching providers/integrations
 *   3. The live /privacy page text  — what visitors actually see
 *
 * It's a sniff test, not a compliance audit. The CI lint already
 * enforces vendors.yaml ↔ codebase parity; this agent catches the
 * fuzzier drift: narrative in privacy.tsx that contradicts the
 * vendor table, missing data-types we should be disclosing, region
 * statements that fell out of date, etc.
 *
 * Output: a single Markdown report on stdout. The workflow that
 * invokes this script either posts to a kanban card / Slack /
 * email if the report is non-empty.
 *
 * Cheap by design — gemini-2.5-flash, single round-trip.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GoogleGenAI } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY not set');
  process.exit(1);
}

const ROOT = process.cwd();

function readFile(rel: string): string {
  try {
    return readFileSync(join(ROOT, rel), 'utf-8');
  } catch {
    return '';
  }
}

function recentVendorTouchingCommits(): string {
  // Surface commits in the last 7 days that touched any
  // vendor-adjacent code. Helps the model spot "we added a new
  // provider but didn't update the policy" cases.
  try {
    return execSync(
      "git log --since='7 days ago' --pretty=format:'%h %s' -- " +
        'package.json .env.example src/lib/providers src/lib/email src/lib/twilio ' +
        'src/lib/supabase docs/legal/ src/app/\\(public\\)/privacy/',
      { encoding: 'utf-8', cwd: ROOT },
    ).trim();
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const vendorsYaml = readFile('docs/legal/vendors.yaml');
  const privacyPage = readFile('src/app/(public)/privacy/page.tsx');
  const recentCommits = recentVendorTouchingCommits();

  const prompt = `You are a privacy-engineering reviewer for a Canadian SaaS (HeyHenry).

Your task: scan the inputs below and produce a SHORT Markdown report
with anything that looks inconsistent, stale, or missing. Don't
hallucinate problems — only flag concrete issues you can point to.
If everything looks fine, output exactly "No drift detected." and
nothing else.

Things to check:
1. Does the narrative in the privacy page contradict any vendor
   entry (e.g. claims data is in Canada when a vendor entry says US)?
2. Are there vendor entries the narrative never mentions, or vice
   versa?
3. Do recent commits touch a provider that doesn't have a
   matching vendor entry or policy paragraph?
4. Is the LAST_UPDATED date stale relative to recent vendor changes?
5. Are there obvious missing data types being disclosed for any vendor?

Output format (Markdown):
- One bullet per issue, prefixed with severity in brackets
  (e.g. "[high] ", "[med] ", "[low] ").
- File path + brief excerpt for each.
- No preamble, no closing remarks.

=== docs/legal/vendors.yaml ===
${vendorsYaml.slice(0, 8000)}

=== src/app/(public)/privacy/page.tsx ===
${privacyPage.slice(0, 8000)}

=== recent commits (last 7 days, vendor-adjacent paths) ===
${recentCommits || '(none)'}
`;

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });
  const text = response.text ?? '';
  console.log(text.trim());
}

main().catch((err) => {
  console.error('drift agent failed:', err);
  process.exit(1);
});
