import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { errorResult, formatDate, textResult } from '../types.js';

export function registerWorklogTools(server: McpServer, tenantId: string) {
  server.tool(
    'search_worklog',
    'Full-text search across worklog entries. Find notes, system events, and milestones.',
    {
      query: z.string().min(1).describe('Search query (supports natural language)'),
      limit: z.number().int().min(1).max(50).default(10).describe('Max results'),
    },
    async ({ query, limit }) => {
      const sql = getDb();
      try {
        const rows = await sql`
          SELECT id, entry_type, title, body, related_type, related_id, created_at,
                 ts_rank(search_vector, websearch_to_tsquery('english', ${query})) AS rank
          FROM worklog_entries
          WHERE tenant_id = ${tenantId}
            AND search_vector @@ websearch_to_tsquery('english', ${query})
          ORDER BY rank DESC, created_at DESC
          LIMIT ${limit}
        `;

        if (rows.length === 0) {
          return textResult(`No worklog entries found matching "${query}".`);
        }

        let output = `Found ${rows.length} worklog entry(ies) matching "${query}":\n\n`;
        for (let i = 0; i < rows.length; i++) {
          const w = rows[i];
          output += `${i + 1}. [${formatDate(w.created_at)}] ${w.title || '(no title)'}\n`;
          output += `   Type: ${w.entry_type}`;
          if (w.related_type) output += ` | Related: ${w.related_type}`;
          output += '\n';
          if (w.body) {
            const bodyPreview = w.body.length > 200 ? `${w.body.substring(0, 200)}...` : w.body;
            output += `   ${bodyPreview}\n`;
          }
          output += `   ID: ${w.id}\n\n`;
        }

        return textResult(output);
      } catch (e) {
        return errorResult(
          `Failed to search worklog: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.tool(
    'add_worklog_note',
    'Add a note to the work log. Use for recording conversations, observations, reminders, or anything worth remembering.',
    {
      title: z.string().min(1).describe('Short title for the note'),
      body: z.string().optional().describe('Longer description or details'),
    },
    async ({ title, body }) => {
      const sql = getDb();
      try {
        const [entry] = await sql`
          INSERT INTO worklog_entries (tenant_id, entry_type, title, body)
          VALUES (${tenantId}, 'note', ${title}, ${body ?? null})
          RETURNING id, title, created_at
        `;

        return textResult(
          `Worklog note added.\n\nTitle: ${entry.title}\nDate: ${formatDate(entry.created_at)}\nID: ${entry.id}`,
        );
      } catch (e) {
        return errorResult(
          `Failed to add worklog note: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );
}
