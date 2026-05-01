import { listExpenses } from '@/lib/db/queries/expenses';
import { listTimeEntries } from '@/lib/db/queries/time-entries';
import { formatCad } from '../format';
import type { AiTool } from '../types';

export const timeExpenseTools: AiTool[] = [
  {
    definition: {
      name: 'log_time',
      description:
        'Log hours worked on a project (with optional budget category) or job. Requires at least one of project_id or job_id.',
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project UUID' },
          job_id: { type: 'string', description: 'Job UUID' },
          budget_category_id: {
            type: 'string',
            description: 'Budget category UUID (for projects)',
          },
          hours: { type: 'number', description: 'Hours worked (e.g. 2.5)' },
          hourly_rate_cents: {
            type: 'number',
            description: 'Hourly rate in cents (optional, for costing)',
          },
          notes: { type: 'string', description: 'Notes about the work done' },
          entry_date: { type: 'string', description: 'Date (YYYY-MM-DD), defaults to today' },
        },
        required: ['hours', 'entry_date'],
      },
    },
    handler: async (input) => {
      try {
        const { logTimeAction } = await import('@/server/actions/time-entries');
        const result = await logTimeAction({
          project_id: input.project_id as string | undefined,
          job_id: input.job_id as string | undefined,
          budget_category_id: input.budget_category_id as string | undefined,
          hours: input.hours as number,
          hourly_rate_cents: input.hourly_rate_cents as number | undefined,
          notes: input.notes as string | undefined,
          entry_date: input.entry_date as string,
        });

        if (!result.ok) return `Failed to log time: ${result.error}`;
        return `Logged ${input.hours} hours on ${input.entry_date}.${input.notes ? ` Notes: ${input.notes}` : ''}\nID: ${result.id}`;
      } catch (e) {
        return `Failed to log time: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'log_expense',
      description:
        'Log an expense on a project (with optional budget category) or job. Requires at least one of project_id or job_id.',
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project UUID' },
          job_id: { type: 'string', description: 'Job UUID' },
          budget_category_id: {
            type: 'string',
            description: 'Budget category UUID (for projects)',
          },
          amount_cents: { type: 'number', description: 'Amount in cents (e.g. 15000 = $150.00)' },
          vendor: { type: 'string', description: 'Vendor name' },
          description: { type: 'string', description: 'What the expense was for' },
          expense_date: { type: 'string', description: 'Date (YYYY-MM-DD), defaults to today' },
        },
        required: ['amount_cents', 'expense_date'],
      },
    },
    handler: async (input) => {
      try {
        const { logExpenseAction } = await import('@/server/actions/expenses');
        const result = await logExpenseAction({
          project_id: input.project_id as string | undefined,
          job_id: input.job_id as string | undefined,
          budget_category_id: input.budget_category_id as string | undefined,
          amount_cents: input.amount_cents as number,
          vendor: input.vendor as string | undefined,
          description: input.description as string | undefined,
          expense_date: input.expense_date as string,
        });

        if (!result.ok) return `Failed to log expense: ${result.error}`;
        return `Logged expense of ${formatCad(input.amount_cents as number)} on ${input.expense_date}.${input.vendor ? ` Vendor: ${input.vendor}` : ''}\nID: ${result.id}`;
      } catch (e) {
        return `Failed to log expense: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'list_time_entries',
      description: 'List time entries. Filter by project, job, category, worker, or date range.',
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Filter by project UUID' },
          job_id: { type: 'string', description: 'Filter by job UUID' },
          user_id: { type: 'string', description: 'Filter by worker user UUID' },
          budget_category_id: { type: 'string', description: 'Filter by budget category UUID' },
          date_from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
          date_to: { type: 'string', description: 'End date (YYYY-MM-DD)' },
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
      },
    },
    handler: async (input) => {
      try {
        const entries = await listTimeEntries({
          project_id: input.project_id as string | undefined,
          job_id: input.job_id as string | undefined,
          user_id: input.user_id as string | undefined,
          budget_category_id: input.budget_category_id as string | undefined,
          date_from: input.date_from as string | undefined,
          date_to: input.date_to as string | undefined,
          limit: Math.min((input.limit as number) || 50, 200),
        });

        if (entries.length === 0) {
          return 'No time entries found matching your criteria.';
        }

        const totalHours = entries.reduce((s, e) => s + e.hours, 0);
        let output = `Found ${entries.length} time entry/entries (${totalHours.toFixed(1)} hours total):\n\n`;
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i];
          output += `${i + 1}. ${e.entry_date} · ${e.hours}h`;
          if (e.notes) output += ` · ${e.notes}`;
          output += `\n   ID: ${e.id}\n`;
        }
        return output;
      } catch (e) {
        return `Failed to list time entries: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'list_expenses',
      description: 'List expenses. Filter by project, job, category, or date range.',
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Filter by project UUID' },
          job_id: { type: 'string', description: 'Filter by job UUID' },
          budget_category_id: { type: 'string', description: 'Filter by budget category UUID' },
          date_from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
          date_to: { type: 'string', description: 'End date (YYYY-MM-DD)' },
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
      },
    },
    handler: async (input) => {
      try {
        const expenses = await listExpenses({
          project_id: input.project_id as string | undefined,
          job_id: input.job_id as string | undefined,
          budget_category_id: input.budget_category_id as string | undefined,
          date_from: input.date_from as string | undefined,
          date_to: input.date_to as string | undefined,
          limit: Math.min((input.limit as number) || 50, 200),
        });

        if (expenses.length === 0) {
          return 'No expenses found matching your criteria.';
        }

        const totalCents = expenses.reduce((s, e) => s + e.amount_cents, 0);
        let output = `Found ${expenses.length} expense(s) (${formatCad(totalCents)} total):\n\n`;
        for (let i = 0; i < expenses.length; i++) {
          const e = expenses[i];
          output += `${i + 1}. ${e.expense_date} · ${formatCad(e.amount_cents)}`;
          if (e.vendor) output += ` · ${e.vendor}`;
          if (e.description) output += ` · ${e.description}`;
          output += `\n   ID: ${e.id}\n`;
        }
        return output;
      } catch (e) {
        return `Failed to list expenses: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];
