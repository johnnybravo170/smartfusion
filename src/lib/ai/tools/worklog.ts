import { getCurrentTenant } from '@/lib/auth/helpers';
import { searchWorklog } from '@/lib/db/queries/worklog';
import { createClient } from '@/lib/supabase/server';
import { formatDate } from '../format';
import type { AiTool } from '../types';

export const worklogTools: AiTool[] = [
  {
    definition: {
      name: 'search_worklog',
      description:
        'Full-text search across worklog entries. Find notes, system events, and milestones.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query (supports natural language)',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 10, max 50)',
          },
        },
        required: ['query'],
      },
    },
    handler: async (input) => {
      try {
        const query = input.query as string;
        const limit = Math.min((input.limit as number) || 10, 50);
        const rows = await searchWorklog(query, limit);

        if (rows.length === 0) {
          return `No worklog entries found matching "${query}".`;
        }

        let output = `Found ${rows.length} worklog entry(ies) matching "${query}":\n\n`;
        for (let i = 0; i < rows.length; i++) {
          const w = rows[i];
          output += `${i + 1}. [${formatDate(w.created_at)}] ${w.title ?? '(no title)'}\n`;
          output += `   Type: ${w.entry_type}`;
          if (w.related_type) output += ` | Related: ${w.related_type}`;
          if (w.related_name) output += ` (${w.related_name})`;
          output += '\n';
          if (w.body) {
            const bodyPreview = w.body.length > 200 ? `${w.body.substring(0, 200)}...` : w.body;
            output += `   ${bodyPreview}\n`;
          }
          output += `   ID: ${w.id}\n\n`;
        }

        return output;
      } catch (e) {
        return `Failed to search worklog: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'create_worklog_note',
      description:
        'Add a note to the work log. Use for recording conversations, observations, reminders, or anything worth remembering.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for the note' },
          body: {
            type: 'string',
            description: 'Longer description or details',
          },
        },
        required: ['title'],
      },
    },
    handler: async (input) => {
      try {
        const tenant = await getCurrentTenant();
        if (!tenant) return 'Not authenticated.';

        const supabase = await createClient();
        const { data, error } = await supabase
          .from('worklog_entries')
          .insert({
            tenant_id: tenant.id,
            entry_type: 'note',
            title: input.title as string,
            body: (input.body as string) ?? null,
          })
          .select('id, title, created_at')
          .single();

        if (error) {
          return `Failed to add worklog note: ${error.message}`;
        }

        return `Worklog note added.\n\nTitle: ${data.title}\nDate: ${formatDate(data.created_at as string)}\nID: ${data.id}`;
      } catch (e) {
        return `Failed to add worklog note: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];
