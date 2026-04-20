import { getBudgetVsActual } from '@/lib/db/queries/project-buckets';
import { getProject, listProjects } from '@/lib/db/queries/projects';
import { createClient } from '@/lib/supabase/server';
import { formatCad, formatDate } from '../format';
import type { AiTool } from '../types';

export const projectTools: AiTool[] = [
  {
    definition: {
      name: 'list_projects',
      description:
        'List renovation projects. Filter by status (planning/in_progress/complete/cancelled) or customer.',
      input_schema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['planning', 'in_progress', 'complete', 'cancelled'],
            description: 'Filter by project status',
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
        const rows = await listProjects({
          status: input.status as 'planning' | 'in_progress' | 'complete' | 'cancelled' | undefined,
          customer_id: input.customer_id as string | undefined,
          limit: Math.min((input.limit as number) || 20, 100),
        });

        if (rows.length === 0) {
          return 'No projects found matching your criteria.';
        }

        let output = `Found ${rows.length} project(s):\n\n`;
        for (let i = 0; i < rows.length; i++) {
          const p = rows[i];
          output += `${i + 1}. ${p.name}`;
          if (p.customer) output += ` (${p.customer.name})`;
          output += `\n   Status: ${p.status} · ${p.percent_complete}% complete`;
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
        'Get full details for a project, including customer info, cost buckets, and budget summary.',
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
        output += `Status: ${project.status}\n`;
        output += `Progress: ${project.percent_complete}%\n`;
        if (project.phase) output += `Phase: ${project.phase}\n`;
        if (project.customer) output += `Customer: ${project.customer.name}\n`;
        if (project.description) output += `Description: ${project.description}\n`;
        if (project.start_date) output += `Start: ${formatDate(project.start_date)}\n`;
        if (project.target_end_date)
          output += `Target end: ${formatDate(project.target_end_date)}\n`;
        output += `Management fee: ${Math.round(project.management_fee_rate * 100)}%\n`;
        output += `\nCost Buckets: ${project.cost_buckets.length}\n`;

        if (project.cost_buckets.length > 0) {
          const totalEstimate = project.cost_buckets.reduce((s, b) => s + b.estimate_cents, 0);
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
        'Create a new renovation project. Seeds default cost buckets automatically. Requires a customer.',
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
        return `Project "${input.name}" created successfully.\nID: ${result.id}\nDefault cost buckets have been seeded (interior + exterior).`;
      } catch (e) {
        return `Failed to create project: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'update_project_status',
      description: 'Update a project status (planning → in_progress → complete, or cancelled).',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Project UUID' },
          status: {
            type: 'string',
            enum: ['planning', 'in_progress', 'complete', 'cancelled'],
            description: 'New status',
          },
        },
        required: ['id', 'status'],
      },
    },
    handler: async (input) => {
      try {
        const { updateProjectStatusAction } = await import('@/server/actions/projects');
        const result = await updateProjectStatusAction({
          id: input.id as string,
          status: input.status as string,
        });

        if (!result.ok) return `Failed to update status: ${result.error}`;
        return `Project status updated to ${input.status}.`;
      } catch (e) {
        return `Failed to update status: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'get_project_budget',
      description:
        'Get budget vs actual spending for a project. Shows each cost bucket with estimate, actual (labor + expenses), and remaining.',
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
        const budget = await getBudgetVsActual(input.id as string);

        if (budget.lines.length === 0) {
          return 'No cost buckets found for this project.';
        }

        let output = `Budget vs Actual\n${'='.repeat(40)}\n\n`;

        // Group by section
        const sections = new Map<string, typeof budget.lines>();
        for (const line of budget.lines) {
          const existing = sections.get(line.section) ?? [];
          existing.push(line);
          sections.set(line.section, existing);
        }

        for (const [section, lines] of sections) {
          output += `${section.toUpperCase()}\n${'-'.repeat(30)}\n`;
          for (const line of lines) {
            output += `  ${line.bucket_name}: `;
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
      } catch (e) {
        return `Failed to get budget: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'get_project_budget_status',
      description:
        'Get budget vs actual spending for renovation projects. Flags projects over 80% budget used.',
      input_schema: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Project UUID. Omit to get all active projects.',
          },
        },
      },
    },
    handler: async (input) => {
      try {
        let projectIds: { id: string; name: string }[] = [];

        if (input.project_id) {
          const project = await getProject(input.project_id as string);
          if (!project) return 'Project not found.';
          projectIds = [{ id: project.id, name: project.name }];
        } else {
          const supabase = await createClient();
          const { data, error } = await supabase
            .from('projects')
            .select('id, name')
            .in('status', ['planning', 'in_progress'])
            .is('deleted_at', null)
            .order('created_at', { ascending: false });

          if (error) {
            return `Failed to list projects: ${error.message}`;
          }
          projectIds = (data ?? []) as { id: string; name: string }[];
        }

        if (projectIds.length === 0) {
          return 'No active projects found.';
        }

        let output = `Project Budget Status\n${'='.repeat(40)}\n\n`;

        for (const proj of projectIds) {
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
        return `Failed to get project budget status: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];
