import { getBudgetVsActual } from '@/lib/db/queries/project-budget-categories';
import { getProject, listProjects } from '@/lib/db/queries/projects';
import { createClient } from '@/lib/supabase/server';
import { formatCad, formatDate } from '../format';
import type { AiTool } from '../types';

export const projectTools: AiTool[] = [
  {
    definition: {
      name: 'list_projects',
      description:
        'List renovation projects. Filter by name (case-insensitive substring match — use this when the operator names a project), lifecycle stage, or customer.',
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Case-insensitive substring of the project name (e.g. "glendwood" matches "Glendwood Reno"). Use this whenever the operator refers to a project by name.',
          },
          stage: {
            type: 'string',
            enum: [
              'planning',
              'awaiting_approval',
              'active',
              'on_hold',
              'declined',
              'complete',
              'cancelled',
            ],
            description: 'Filter by lifecycle stage',
          },
          customer_id: {
            type: 'string',
            description: 'Filter by customer UUID',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 20, max 100)',
          },
        },
      },
    },
    handler: async (input) => {
      try {
        const nameFilter = input.name as string | undefined;
        const rows = await listProjects({
          stage: input.stage as import('@/lib/validators/project').LifecycleStage | undefined,
          customer_id: input.customer_id as string | undefined,
          name: nameFilter,
          limit: Math.min((input.limit as number) || 20, 100),
        });

        if (rows.length === 0) {
          // Voice transcription often mangles project names (Glenwood ↦ Glennwood).
          // On a name miss, surface candidates so the model can self-correct
          // instead of bouncing back to the operator for a respelling.
          if (nameFilter) {
            const candidates = await listProjects({ limit: 15 });
            if (candidates.length > 0) {
              let out = `No projects matched "${nameFilter}". Here are recent projects — pick the closest match by name and call this tool again or use its id:\n\n`;
              for (let i = 0; i < candidates.length; i++) {
                const p = candidates[i];
                out += `${i + 1}. ${p.name}`;
                if (p.customer) out += ` (${p.customer.name})`;
                out += ` · ${p.lifecycle_stage}\n   ID: ${p.id}\n`;
              }
              return out;
            }
          }
          return 'No projects found matching your criteria.';
        }

        let output = `Found ${rows.length} project(s):\n\n`;
        for (let i = 0; i < rows.length; i++) {
          const p = rows[i];
          output += `${i + 1}. ${p.name}`;
          if (p.customer) output += ` (${p.customer.name})`;
          output += `\n   Stage: ${p.lifecycle_stage} · ${p.percent_complete}% complete`;
          if (p.start_date) output += ` · Started: ${formatDate(p.start_date)}`;
          output += `\n   ID: ${p.id}\n`;
        }
        return output;
      } catch (e) {
        return `Failed to list projects: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'get_project',
      description:
        'Get full details for a project, including customer info, budget categories, and budget summary.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Project UUID' },
        },
        required: ['id'],
      },
    },
    handler: async (input) => {
      try {
        const project = await getProject(input.id as string);
        if (!project) return 'Project not found.';

        let output = `Project: ${project.name}\n${'='.repeat(40)}\n\n`;
        output += `Stage: ${project.lifecycle_stage}\n`;
        output += `Progress: ${project.percent_complete}%\n`;
        if (project.customer) output += `Customer: ${project.customer.name}\n`;
        if (project.description) output += `Description: ${project.description}\n`;
        if (project.start_date) output += `Start: ${formatDate(project.start_date)}\n`;
        if (project.target_end_date)
          output += `Target end: ${formatDate(project.target_end_date)}\n`;
        output += `Management fee: ${Math.round(project.management_fee_rate * 100)}%\n`;
        output += `\nBudget Categories: ${project.budget_categories.length}\n`;

        if (project.budget_categories.length > 0) {
          const totalEstimate = project.budget_categories.reduce((s, b) => s + b.estimate_cents, 0);
          output += `Total estimate: ${formatCad(totalEstimate)}\n`;
        }

        output += `\nCreated: ${formatDate(project.created_at)}\n`;
        return output;
      } catch (e) {
        return `Failed to get project: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'create_project',
      description:
        'Create a new renovation project. Seeds default budget categories automatically. Requires a customer.',
      input_schema: {
        type: 'object',
        properties: {
          customer_id: { type: 'string', description: 'Customer UUID' },
          name: { type: 'string', description: 'Project name' },
          description: { type: 'string', description: 'Project description' },
          start_date: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
          target_end_date: { type: 'string', description: 'Target end date (YYYY-MM-DD)' },
          management_fee_rate: {
            type: 'number',
            description: 'Management fee rate as decimal (default 0.12 = 12%)',
          },
        },
        required: ['customer_id', 'name'],
      },
    },
    handler: async (input) => {
      try {
        // Dynamic import to avoid circular deps
        const { createProjectAction } = await import('@/server/actions/projects');
        const result = await createProjectAction({
          customer_id: input.customer_id as string,
          name: input.name as string,
          description: input.description as string | undefined,
          start_date: input.start_date as string | undefined,
          target_end_date: input.target_end_date as string | undefined,
          management_fee_rate: input.management_fee_rate as number | undefined,
        });

        if (!result.ok) return `Failed to create project: ${result.error}`;
        return `Project "${input.name}" created successfully.\nID: ${result.id}\nDefault budget categories have been seeded (interior + exterior).`;
      } catch (e) {
        return `Failed to create project: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'update_project',
      description:
        'Patch fields on an existing project. Useful when the operator says things like "the Glenwood project is starting March 4" or "push the kitchen reno end date back two weeks" — you\'d update start_date / target_end_date here. Only fields you supply are written; omitted fields stay as-is. Lifecycle stage transitions go through transition_project_stage instead.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Project UUID' },
          name: { type: 'string', description: 'New name' },
          description: { type: 'string', description: 'New description' },
          start_date: {
            type: 'string',
            description:
              'New start date (YYYY-MM-DD). Anchors the Gantt timeline. Use empty string to clear.',
          },
          target_end_date: {
            type: 'string',
            description: 'New target end date (YYYY-MM-DD). Use empty string to clear.',
          },
        },
        required: ['id'],
      },
    },
    handler: async (input) => {
      try {
        const id = input.id as string;
        const startDateRaw = input.start_date as string | undefined;
        const endDateRaw = input.target_end_date as string | undefined;
        const name = input.name as string | undefined;
        const description = input.description as string | undefined;

        // start_date is the most common single-field update (anchoring
        // the Gantt). Use the dedicated action for it; everything else
        // requires the full-record updateProjectAction so we fetch +
        // merge.
        let didSomething = false;
        const messages: string[] = [];

        if (startDateRaw !== undefined) {
          const { updateProjectStartDateAction } = await import('@/server/actions/projects');
          const res = await updateProjectStartDateAction({
            id,
            start_date: startDateRaw === '' ? null : startDateRaw,
          });
          if (!res.ok) return `Failed to update start_date: ${res.error}`;
          didSomething = true;
          messages.push(
            startDateRaw === '' ? 'Start date cleared.' : `Start date set to ${startDateRaw}.`,
          );
        }

        if (name !== undefined || description !== undefined || endDateRaw !== undefined) {
          const project = await getProject(id);
          if (!project) return 'Project not found.';
          const { updateProjectAction } = await import('@/server/actions/projects');
          const res = await updateProjectAction({
            id,
            customer_id: project.customer?.id ?? '',
            name: name ?? project.name,
            description: description ?? project.description ?? '',
            start_date: project.start_date ?? '',
            target_end_date:
              endDateRaw !== undefined ? endDateRaw : (project.target_end_date ?? ''),
            management_fee_rate: project.management_fee_rate,
          });
          if (!res.ok) return `Failed to update project: ${res.error}`;
          didSomething = true;
          if (name !== undefined) messages.push(`Renamed to "${name}".`);
          if (description !== undefined) messages.push('Description updated.');
          if (endDateRaw !== undefined) {
            messages.push(
              endDateRaw === '' ? 'Target end date cleared.' : `Target end set to ${endDateRaw}.`,
            );
          }
        }

        if (!didSomething) return 'Nothing to update — supply at least one field.';
        return messages.join(' ');
      } catch (e) {
        return `Failed to update project: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'transition_project_stage',
      description:
        'Move a project to a new lifecycle stage. Common transitions: planning → awaiting_approval (happens via send_estimate) → active → complete.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Project UUID' },
          stage: {
            type: 'string',
            enum: [
              'planning',
              'awaiting_approval',
              'active',
              'on_hold',
              'declined',
              'complete',
              'cancelled',
            ],
            description: 'New lifecycle stage',
          },
        },
        required: ['id', 'stage'],
      },
    },
    handler: async (input) => {
      try {
        const { transitionLifecycleStageAction } = await import('@/server/actions/projects');
        const result = await transitionLifecycleStageAction({
          id: input.id as string,
          stage: input.stage as import('@/lib/validators/project').LifecycleStage,
        });

        if (!result.ok) return `Failed to update stage: ${result.error}`;
        return `Project moved to ${input.stage}.`;
      } catch (e) {
        return `Failed to update stage: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'get_project_budget',
      description:
        'Budget vs actual spending. Pass a project id to get the full per-category breakdown for one project (Framing, Plumbing, Electrical, etc with estimate/actual/remaining). Omit id to get an active-projects rollup with totals and over-80% warnings. Use this whenever the operator asks how much was spent on a category like framing for a specific project.',
      input_schema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description:
              'Project UUID. Required for per-category breakdown. Omit to roll up all active projects.',
          },
        },
      },
    },
    handler: async (input) => {
      try {
        if (input.id) {
          return await renderProjectBudgetDetail(input.id as string);
        }

        const supabase = await createClient();
        const { data, error } = await supabase
          .from('projects')
          .select('id, name')
          .in('lifecycle_stage', ['planning', 'awaiting_approval', 'active'])
          .is('deleted_at', null)
          .order('created_at', { ascending: false });

        if (error) return `Failed to list projects: ${error.message}`;
        const projects = (data ?? []) as { id: string; name: string }[];
        if (projects.length === 0) return 'No active projects found.';

        let output = `Project Budget Status\n${'='.repeat(40)}\n\n`;
        for (const proj of projects) {
          const budget = await getBudgetVsActual(proj.id);
          const pct =
            budget.total_estimate_cents > 0
              ? Math.round((budget.total_actual_cents / budget.total_estimate_cents) * 100)
              : 0;
          const warning = pct >= 80 ? ' ⚠ OVER 80%' : '';
          output += `${proj.name}${warning}\n`;
          output += `  Budget: ${formatCad(budget.total_estimate_cents)}`;
          output += ` · Spent: ${formatCad(budget.total_actual_cents)}`;
          output += ` · ${pct}% used\n`;
          if (budget.total_remaining_cents < 0) {
            output += `  Remaining: ${formatCad(budget.total_remaining_cents)} [OVER BUDGET]\n`;
          } else {
            output += `  Remaining: ${formatCad(budget.total_remaining_cents)}\n`;
          }
          output += '\n';
        }
        return output;
      } catch (e) {
        return `Failed to get budget: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'upsert_project_budget_category',
      description:
        'Add a new budget category to a project, or update an existing one. Use this when the operator asks to add a scope item to a project (e.g. "add a $10K steam room to the ensuite") or to bump an existing category\'s estimate. Pass `id` to update an existing category; omit `id` to create a new one. Adding a category only changes the internal budget — it does NOT bill the customer. After calling this, offer to create a Change Order via create_change_order if the addition is customer-billable scope.',
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project UUID. Required.' },
          id: {
            type: 'string',
            description:
              'Budget category UUID. Provide to update an existing category; omit to create a new one.',
          },
          name: {
            type: 'string',
            description:
              'Category name (e.g. "Steam Room", "Heated Floors"). Required when creating; ignored when updating.',
          },
          section: {
            type: 'string',
            description:
              'Category section. Common values are "interior" or "exterior". Required when creating; ignored when updating. Default to "interior" for indoor scope additions like ensuites/kitchens/baths.',
          },
          estimate_cents: {
            type: 'number',
            description:
              'Estimate in cents (e.g. 1000000 for $10,000). Required when creating; optional when updating.',
          },
          description: {
            type: 'string',
            description: 'Optional free-text note about the category.',
          },
        },
        required: ['project_id'],
      },
    },
    handler: async (input) => {
      try {
        const projectId = input.project_id as string | undefined;
        if (!projectId) return 'project_id is required.';

        const id = input.id as string | undefined;
        if (id) {
          const { updateBudgetCategoryAction } = await import(
            '@/server/actions/project-budget-categories'
          );
          const result = await updateBudgetCategoryAction({
            id,
            project_id: projectId,
            estimate_cents: input.estimate_cents as number | undefined,
            description: input.description as string | undefined,
          });
          if (!result.ok) return `Failed to update category: ${result.error}`;
          return `Updated budget category ${id}.`;
        }

        const name = input.name as string | undefined;
        const section = (input.section as string | undefined) ?? 'interior';
        if (!name) return 'name is required when creating a new budget category.';
        const estimateCents = input.estimate_cents as number | undefined;
        if (estimateCents === undefined) {
          return 'estimate_cents is required when creating a new budget category.';
        }

        const { addBudgetCategoryAction } = await import(
          '@/server/actions/project-budget-categories'
        );
        const result = await addBudgetCategoryAction({
          project_id: projectId,
          name,
          section,
          description: input.description as string | undefined,
          estimate_cents: estimateCents,
        });
        if (!result.ok) return `Failed to add category: ${result.error}`;
        return `Added "${name}" (${section}) to the project budget at ${formatCad(estimateCents)}. Category id: ${result.id}. This is an internal budget change — if the customer is being billed for this scope, follow up by creating a Change Order.`;
      } catch (e) {
        return `Failed to upsert category: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];

async function renderProjectBudgetDetail(projectId: string): Promise<string> {
  const budget = await getBudgetVsActual(projectId);
  if (budget.lines.length === 0) return 'No budget categories found for this project.';

  let output = `Budget vs Actual\n${'='.repeat(40)}\n\n`;
  const sections = new Map<string, typeof budget.lines>();
  for (const line of budget.lines) {
    const existing = sections.get(line.section) ?? [];
    existing.push(line);
    sections.set(line.section, existing);
  }
  for (const [section, lines] of sections) {
    output += `${section.toUpperCase()}\n${'-'.repeat(30)}\n`;
    for (const line of lines) {
      output += `  ${line.budget_category_name}: `;
      output += `Est ${formatCad(line.estimate_cents)} · `;
      output += `Actual ${formatCad(line.actual_cents)} · `;
      output += `Remaining ${formatCad(line.remaining_cents)}`;
      if (line.remaining_cents < 0) output += ' [OVER BUDGET]';
      output += '\n';
    }
    output += '\n';
  }
  output += `TOTALS\n`;
  output += `  Estimated: ${formatCad(budget.total_estimate_cents)}\n`;
  output += `  Actual:    ${formatCad(budget.total_actual_cents)}\n`;
  output += `  Remaining: ${formatCad(budget.total_remaining_cents)}\n`;
  return output;
}
