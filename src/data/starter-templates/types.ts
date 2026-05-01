/**
 * Type for hand-authored renovation starter templates.
 *
 * Templates are JSON files in this folder, applied to fresh projects
 * via `applyStarterTemplateAction`. The action seeds
 * `project_budget_categories` and `project_cost_lines` under the
 * chosen project — no schema migration needed.
 *
 * Pricing convention: ship without prices (no `unit_price_cents`,
 * no `unit_cost_cents`). Per the rollup, prices drift quickly and the
 * operator should fill them in per project. Templates are about
 * *structure* — what scope is in this kind of job.
 */

export type StarterTemplateLine = {
  label: string;
  category: 'material' | 'labour' | 'sub' | 'equipment' | 'overhead';
  qty: number;
  unit: string;
  notes?: string;
};

export type StarterTemplateCategory = {
  name: string;
  section: string;
  description?: string;
  lines: StarterTemplateLine[];
};

export type StarterTemplate = {
  slug: string;
  label: string;
  description: string;
  categories: StarterTemplateCategory[];
};
