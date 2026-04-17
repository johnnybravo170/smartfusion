import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { errorResult, formatDate, textResult } from '../types.js';

export function registerTodoTools(server: McpServer, tenantId: string) {
  server.tool(
    'list_todos',
    'List todos. Filter by completion status.',
    {
      done: z.boolean().optional().describe('Filter: true = completed, false = open, omit = all'),
      limit: z.number().int().min(1).max(100).default(20).describe('Max results'),
    },
    async ({ done, limit }) => {
      const sql = getDb();
      try {
        const conditions = [sql`tenant_id = ${tenantId}`];
        if (done !== undefined) {
          conditions.push(sql`done = ${done}`);
        }

        const where = conditions.reduce((a, b) => sql`${a} AND ${b}`);
        const rows = await sql`
          SELECT id, title, done, due_date, related_type, related_id, created_at
          FROM todos
          WHERE ${where}
          ORDER BY done ASC, COALESCE(due_date, '9999-12-31') ASC, created_at DESC
          LIMIT ${limit}
        `;

        if (rows.length === 0) {
          return textResult('No todos found.');
        }

        let output = `Found ${rows.length} todo(s):\n\n`;
        for (let i = 0; i < rows.length; i++) {
          const t = rows[i];
          const check = t.done ? '[x]' : '[ ]';
          output += `${i + 1}. ${check} ${t.title}`;
          if (t.due_date) output += ` (due: ${formatDate(t.due_date)})`;
          if (t.related_type) output += ` [${t.related_type}]`;
          output += `\n   ID: ${t.id}\n`;
        }

        return textResult(output);
      } catch (e) {
        return errorResult(`Failed to list todos: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'create_todo',
    'Create a new todo item.',
    {
      title: z.string().min(1).describe('Todo title/description'),
      due_date: z.string().optional().describe('Due date (YYYY-MM-DD format)'),
    },
    async ({ title, due_date }) => {
      const sql = getDb();
      try {
        // Use a placeholder user_id since MCP doesn't have auth context.
        // The tenant_id owner is the implicit user.
        const [todo] = await sql`
          INSERT INTO todos (tenant_id, user_id, title, due_date)
          VALUES (
            ${tenantId},
            '00000000-0000-0000-0000-000000000000',
            ${title},
            ${due_date ?? null}
          )
          RETURNING id, title, due_date
        `;

        let output = `Todo created.\n\nTitle: ${todo.title}`;
        if (todo.due_date) output += `\nDue: ${formatDate(todo.due_date)}`;
        output += `\nID: ${todo.id}`;

        return textResult(output);
      } catch (e) {
        return errorResult(`Failed to create todo: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'complete_todo',
    'Mark a todo as done.',
    {
      id: z.string().uuid().describe('Todo UUID'),
    },
    async ({ id }) => {
      const sql = getDb();
      try {
        const [todo] = await sql`
          UPDATE todos
          SET done = true, updated_at = now()
          WHERE id = ${id} AND tenant_id = ${tenantId}
          RETURNING id, title
        `;

        if (!todo) {
          return errorResult('Todo not found.');
        }

        return textResult(`Todo completed: "${todo.title}"`);
      } catch (e) {
        return errorResult(
          `Failed to complete todo: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );
}
