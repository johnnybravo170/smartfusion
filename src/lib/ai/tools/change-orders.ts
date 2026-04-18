import { getChangeOrderSummaryForProject, listChangeOrders } from '@/lib/db/queries/change-orders';
import { formatCad, formatDate } from '../format';
import type { AiTool } from '../types';

export const changeOrderStatusLabels: Record<string, string> = {
  draft: 'Draft',
  pending_approval: 'Pending Approval',
  approved: 'Approved',
  declined: 'Declined',
  voided: 'Voided',
};

export const changeOrderTools: AiTool[] = [
  {
    definition: {
      name: 'list_change_orders',
      description:
        'List change orders for a project. Optionally filter by status (draft/pending_approval/approved/declined/voided).',
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project UUID' },
          status: {
            type: 'string',
            enum: ['draft', 'pending_approval', 'approved', 'declined', 'voided'],
            description: 'Filter by status',
          },
        },
        required: ['project_id'],
      },
    },
    handler: async (input) => {
      try {
        let rows = await listChangeOrders(input.project_id as string);

        if (input.status) {
          rows = rows.filter((r) => r.status === input.status);
        }

        if (rows.length === 0) {
          return 'No change orders found.';
        }

        let output = `Found ${rows.length} change order(s):\n\n`;
        for (let i = 0; i < rows.length; i++) {
          const co = rows[i];
          output += `${i + 1}. ${co.title}\n`;
          output += `   Status: ${changeOrderStatusLabels[co.status] ?? co.status}`;
          output += ` · Cost: ${co.cost_impact_cents >= 0 ? '+' : ''}${formatCad(co.cost_impact_cents)}`;
          if (co.timeline_impact_days !== 0) {
            output += ` · Timeline: ${co.timeline_impact_days > 0 ? '+' : ''}${co.timeline_impact_days}d`;
          }
          output += `\n   Created: ${formatDate(co.created_at)}`;
          if (co.approved_by_name) output += ` · Approved by: ${co.approved_by_name}`;
          output += `\n   ID: ${co.id}\n`;
        }
        return output;
      } catch (e) {
        return `Failed to list change orders: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'create_change_order',
      description:
        'Create a change order for a project. Optionally send it for approval immediately.',
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project UUID' },
          title: { type: 'string', description: 'Change order title' },
          description: { type: 'string', description: 'What changed and why' },
          reason: { type: 'string', description: 'Reason for the change' },
          cost_impact_dollars: {
            type: 'number',
            description: 'Cost impact in dollars (positive = increase, negative = decrease)',
          },
          timeline_impact_days: {
            type: 'number',
            description: 'Timeline impact in days (positive = longer, negative = shorter)',
          },
          send_immediately: {
            type: 'boolean',
            description: 'Send for approval right away (default false)',
          },
        },
        required: ['project_id', 'title', 'description'],
      },
    },
    handler: async (input) => {
      try {
        const { createChangeOrderAction, sendChangeOrderAction } = await import(
          '@/server/actions/change-orders'
        );

        const costCents = Math.round(((input.cost_impact_dollars as number) || 0) * 100);

        const result = await createChangeOrderAction({
          project_id: input.project_id as string,
          title: input.title as string,
          description: input.description as string,
          reason: input.reason as string | undefined,
          cost_impact_cents: costCents,
          timeline_impact_days: (input.timeline_impact_days as number) || 0,
        });

        if (!result.ok) return `Failed to create change order: ${result.error}`;

        let output = `Change order "${input.title}" created.\nID: ${result.id}`;

        if (input.send_immediately && result.id) {
          const sendResult = await sendChangeOrderAction(result.id);
          if (sendResult.ok) {
            output += '\nSent for approval.';
          } else {
            output += `\nCreated but failed to send: ${sendResult.error}`;
          }
        }

        return output;
      } catch (e) {
        return `Failed to create change order: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'get_change_order_summary',
      description:
        "Get total approved and pending cost + timeline impact for a project's change orders.",
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project UUID' },
        },
        required: ['project_id'],
      },
    },
    handler: async (input) => {
      try {
        const summary = await getChangeOrderSummaryForProject(input.project_id as string);

        let output = `Change Order Summary\n${'='.repeat(30)}\n\n`;
        output += `Approved:\n`;
        output += `  Cost impact: ${formatCad(summary.approved_cost_cents)}\n`;
        output += `  Timeline impact: ${summary.approved_timeline_days}d\n\n`;
        output += `Pending (${summary.pending_count} order${summary.pending_count === 1 ? '' : 's'}):\n`;
        output += `  Cost impact: ${formatCad(summary.pending_cost_cents)}\n`;
        output += `  Timeline impact: ${summary.pending_timeline_days}d\n`;

        return output;
      } catch (e) {
        return `Failed to get summary: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'add_portal_update',
      description:
        'Post an update to the homeowner portal. Types: progress, photo, milestone, message.',
      input_schema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Project UUID' },
          type: {
            type: 'string',
            enum: ['progress', 'photo', 'milestone', 'message'],
            description: 'Update type',
          },
          title: { type: 'string', description: 'Update title' },
          body: { type: 'string', description: 'Update body/details' },
        },
        required: ['project_id', 'type', 'title'],
      },
    },
    handler: async (input) => {
      try {
        const { addPortalUpdateAction } = await import('@/server/actions/portal-updates');

        const result = await addPortalUpdateAction({
          projectId: input.project_id as string,
          type: input.type as 'progress' | 'photo' | 'milestone' | 'message',
          title: input.title as string,
          body: input.body as string | undefined,
        });

        if (!result.ok) return `Failed to post update: ${result.error}`;
        return `Portal update posted: "${input.title}"`;
      } catch (e) {
        return `Failed to post update: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];
