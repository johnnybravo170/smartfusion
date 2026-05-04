/**
 * Pulls existing-customer context to fold into the intake parse prompt.
 *
 * The operator-supplied customer name on the intake form gets fuzzy-
 * matched against existing customers. If there's a hit, we hydrate
 * their last few projects' shape (categories, sample line labels)
 * and Henry uses that to:
 *
 *   - bias category choices toward what we've seen this customer
 *     have on prior projects (a customer who's always had "Stairs"
 *     as a category should keep getting that section)
 *   - skip suggestions for things we already know they prefer
 *     differently (e.g. "Tony has used customer-supplied flooring
 *     on 3 prior projects, so the supply line goes there")
 *   - voice the reply draft as a continuation, not a stranger intro
 *
 * V1 scope: match by operator-typed name only. If the form was left
 * blank and the model later extracts the name from the audio, we do
 * NOT re-recognize on the fly — the parse has already happened. Future
 * iteration could run a second pass after extraction lands a name.
 */

import { findContactMatches } from '@/lib/db/queries/contact-matches';
import { createClient } from '@/lib/supabase/server';

export type IntakeCustomerContext = {
  customerId: string;
  customerName: string;
  matchedOn: 'phone' | 'email' | 'name' | 'similar_name';
  projects: Array<{
    name: string;
    description: string | null;
    completedAt: string | null;
    categories: Array<{
      name: string;
      section: string | null;
      sampleLines: string[];
    }>;
  }>;
};

export async function loadIntakeCustomerContext(
  customerName: string,
): Promise<IntakeCustomerContext | null> {
  const trimmed = customerName.trim();
  if (trimmed.length < 2) return null;

  const matches = await findContactMatches({ name: trimmed });
  if (matches.length === 0) return null;

  // Take the first match — findContactMatches surfaces strong matches
  // (phone / email) before fuzzy name matches when multiple inputs are
  // provided; here we only have name so all matches are name-based.
  // If the operator typed a unique-enough name to single-match, we
  // win. If multiple plausible matches exist (e.g. two "Tony"s in the
  // tenant), we'd want a UI disambiguation step — out of scope for V1.
  const customer = matches[0];

  const supabase = await createClient();
  const { data: projects } = await supabase
    .from('projects')
    .select(
      `
      id,
      name,
      description,
      completed_at,
      project_budget_categories (
        name,
        section,
        project_cost_lines (label)
      )
    `,
    )
    .eq('customer_id', customer.id)
    .order('created_at', { ascending: false })
    .limit(3);

  return {
    customerId: customer.id,
    customerName: customer.name,
    matchedOn: customer.matchedOn,
    projects: (projects ?? []).map((p) => ({
      name: p.name as string,
      description: (p.description as string | null) ?? null,
      completedAt: (p.completed_at as string | null) ?? null,
      categories: (
        (p.project_budget_categories as Array<{
          name: string;
          section: string | null;
          project_cost_lines: Array<{ label: string }> | null;
        }> | null) ?? []
      ).map((c) => ({
        name: c.name,
        section: c.section,
        sampleLines: (c.project_cost_lines ?? []).slice(0, 3).map((l) => l.label),
      })),
    })),
  };
}

/**
 * Render the customer-context section that gets injected into the
 * intake prompt. Returns null when there's no context to inject.
 */
export function renderCustomerContextForPrompt(
  context: IntakeCustomerContext | null,
): string | null {
  if (!context) return null;
  if (context.projects.length === 0) {
    return `RECOGNIZED EXISTING CUSTOMER: ${context.customerName} (matched by ${context.matchedOn}). No prior projects on file. Use the customer name in the reply but do not invent prior context.`;
  }
  const projectBlocks = context.projects.map((p, i) => {
    const completedHint = p.completedAt ? ' (completed)' : '';
    const cats = p.categories
      .slice(0, 6)
      .map((c) => {
        const samples = c.sampleLines.length > 0 ? ` — e.g. ${c.sampleLines.join('; ')}` : '';
        return `    - ${c.section ?? 'General'} / ${c.name}${samples}`;
      })
      .join('\n');
    return `  Project ${i + 1}: "${p.name}"${completedHint}${
      p.description ? `\n  Description: ${p.description.slice(0, 200)}` : ''
    }\n  Categories used:\n${cats || '    (none)'}`;
  });
  return [
    `RECOGNIZED EXISTING CUSTOMER: ${context.customerName} (matched by ${context.matchedOn}).`,
    'Their recent projects (most recent first) — use this to inform category choices, line-item familiarity, and reply tone (continuation, not stranger intro). Extract from the NEW artifacts as the source of truth; do not invent details from prior projects.',
    projectBlocks.join('\n\n'),
  ].join('\n\n');
}
